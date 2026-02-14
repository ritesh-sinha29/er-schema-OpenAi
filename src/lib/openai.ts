// src/lib/openai.ts
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { z } from "zod";
import type { ERModel, SchemaFormat, DetectionResult } from "@/types/ERmodel";

/**
 * Zod schemas for structured output validation
 */
const FieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  isPrimary: z.boolean().optional(),
  isForeign: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  defaultValue: z.string().optional(),
  foreignTable: z.string().optional(),
});

const RelationSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["1-1", "1-M", "M-1", "M-M"]),
  fromField: z.string().optional(),
  toField: z.string().optional(),
});

const EntitySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  fields: z.array(FieldSchema),
  relations: z.array(RelationSchema).optional(),
});

const ERModelSchema = z.object({
  entities: z.array(EntitySchema),
  parseError: z.boolean().optional(),
  reason: z.string().optional(),
});

/**
 * OpenAI client singleton
 */
let openaiClient: ReturnType<typeof createOpenAI> | null = null;

function getOpenAIClient() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not found in environment");
    openaiClient = createOpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Detect schema format using regex patterns
 */
export function detectSchemaFormat(content: string): DetectionResult {
  const first100Lines = content.split("\n").slice(0, 100).join("\n");
  const contentLower = content.toLowerCase();

  const patterns: Array<[SchemaFormat, RegExp, "high" | "medium"]> = [
    ["sql", /CREATE\s+TABLE/i, "high"],
    ["prisma", /model\s+\w+\s*{/, "high"],
    ["convex", /defineTable|defineSchema/, "high"],
    ["mongoose", /new\s+Schema|mongoose\.Schema/, "high"],
    ["graphql", /type\s+\w+\s*{/, "medium"],
    ["typescript", /(interface|type)\s+\w+/, "medium"],
  ];

  for (const [format, pattern, confidence] of patterns) {
    if (pattern.test(first100Lines)) {
      if (format === "graphql" && !/schema\s*{/.test(contentLower)) continue;
      if (format === "prisma" && !/@/.test(content)) continue;
      return { format, confidence, prompt: getFormatPrompt(format) };
    }
  }

  return {
    format: "unknown",
    confidence: "low",
    prompt: getFormatPrompt("unknown"),
  };
}

/**
 * Format-specific parsing instructions
 */
export function getFormatPrompt(format: SchemaFormat): string {
  const base = `Extract database entities, fields, and relationships. Return valid JSON matching ERModel structure.

RULES:
1. Set parseError: true if no database structure found
2. Do NOT hallucinate relationships
3. Infer relationships only from explicit foreign keys or references

ERModel Structure:
{
  "entities": [{
    "name": "string",
    "description": "string (optional)",
    "fields": [{
      "name": "string",
      "type": "string",
      "isPrimary": boolean,
      "isForeign": boolean,
      "isRequired": boolean,
      "isUnique": boolean,
      "defaultValue": "string (optional)",
      "foreignTable": "string (if isForeign=true)"
    }],
    "relations": [{
      "from": "string",
      "to": "string",
      "type": "1-1|1-M|M-1|M-M",
      "fromField": "string",
      "toField": "string"
    }]
  }]
}`;

  const instructions: Record<SchemaFormat, string> = {
    sql: `SQL: PRIMARY KEY → isPrimary, FOREIGN KEY/REFERENCES → isForeign+foreignTable, NOT NULL → isRequired, UNIQUE → isUnique, DEFAULT → defaultValue`,
    prisma: `PRISMA: @id → isPrimary, @relation → isForeign, Array fields → 1-M, ? → isRequired:false, @default → defaultValue`,
    convex: `CONVEX: _id → isPrimary, v.id("table") → isForeign+foreignTable, v.optional() → isRequired:false`,
    typescript: `TYPESCRIPT: "id"/"_id" → isPrimary, fields ending "Id" → possibly foreign keys, Array types → 1-M, ? → isRequired:false`,
    mongoose: `MONGOOSE: _id → isPrimary, ObjectId+ref → isForeign+foreignTable, required:true → isRequired, default → defaultValue`,
    graphql: `GRAPHQL: "id" field → isPrimary, type references → foreign keys, [Type] → 1-M, ! → isRequired`,
    unknown: `UNKNOWN: Intelligently detect structure. Look for entity/table patterns. Infer primary keys (id, _id). Make educated guesses.`,
  };

  return `${base}\n\n${instructions[format]}`;
}

/**
 * Parse schema with OpenAI (non-streaming)
 */
export async function parseSchemaWithOpenAI(
  schemaContent: string,
  formatHint?: SchemaFormat
): Promise<ERModel> {
  const client = getOpenAIClient();
  const detection = formatHint
    ? { format: formatHint, prompt: getFormatPrompt(formatHint) }
    : detectSchemaFormat(schemaContent);

  const prompt = `${detection.prompt}

SCHEMA TO PARSE:
\`\`\`
${schemaContent}
\`\`\``;

  try {
    console.log(`[OpenAI] Parsing ${detection.format} schema...`);

    // Use generateText with manual JSON parsing to avoid strict schema validation
    const { text } = await generateText({
      model: client("gpt-4o-mini"),
      prompt: `${prompt}\n\nIMPORTANT: Return ONLY valid JSON matching the ERModel structure. No markdown, no code blocks, just pure JSON.`,
      temperature: 0,
      maxRetries: 3,
    });

    // Parse and validate JSON
    let parsed;
    try {
      // Remove markdown code blocks if present
      const cleanedText = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleanedText);
    } catch (e) {
      throw new Error("Failed to parse AI response as JSON");
    }

    // Validate with Zod
    const object = ERModelSchema.parse(parsed);

    if (object.parseError) {
      throw new Error(
        object.reason || "Please upload a valid database schema"
      );
    }

    if (!object.entities || object.entities.length === 0) {
      throw new Error("Please upload a valid database schema");
    }

    // Process entities to add defaults for optional fields
    const erModel: ERModel = {
      entities: object.entities.map((entity) => ({
        ...entity,
        relations: entity.relations || [],
        fields: entity.fields.map((field) => ({
          ...field,
          isPrimary: field.isPrimary ?? false,
          isForeign: field.isForeign ?? false,
          isRequired: field.isRequired ?? false,
          isUnique: field.isUnique ?? false,
        })),
      })),
      timestamp: new Date().toISOString(),
    };

    console.log(`[OpenAI] ✓ Parsed ${erModel.entities.length} entities`);
    return erModel;
  } catch (error) {
    console.error("[OpenAI] Parse failed:", error);

    if (error instanceof Error) {
      if (error.message.includes("database schema")) {
        throw error;
      }
      throw new Error("Schema parsing failed. Please check your input.");
    }

    throw new Error("Schema parsing failed. Please try again.");
  }
}
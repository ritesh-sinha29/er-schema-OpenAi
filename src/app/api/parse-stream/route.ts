import { NextRequest } from "next/server";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import {
  detectSchemaFormat,
  getFormatPrompt,
  parseSchemaWithOpenAI,
} from "@/lib/openai";
import {
  generateSessionId,
  ermodelToReactFlow,
  applyDagreLayout,
  validateERModel,
} from "@/modules/my-project/ErHelper";

export const maxDuration = 180;

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const { schemaContent } = await req.json();

  if (!schemaContent || typeof schemaContent !== "string") {
    return new Response(
      encoder.encode(
        JSON.stringify({
          type: "error",
          error: "Schema content is required",
        })
      ),
      { status: 400 }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        // Step 1: Format detection
        send({ type: "progress", message: "Analyzing schema format..." });
        const detection = detectSchemaFormat(schemaContent);
        send({
          type: "format",
          format: detection.format,
          confidence: detection.confidence,
        });

        // Step 2: Parse with OpenAI
        send({
          type: "progress",
          message: `Parsing ${detection.format} schema...`,
        });

        const ermodel = await parseSchemaWithOpenAI(schemaContent);

        send({
          type: "progress",
          message: `Found ${ermodel.entities.length} entities`,
        });

        // Step 3: Validate
        send({ type: "progress", message: "Validating schema..." });
        const validation = validateERModel(ermodel);

        if (!validation.valid) {
          send({
            type: "error",
            error: `Validation failed: ${validation.errors.join(", ")}`,
          });
          controller.close();
          return;
        }

        // Send warnings
        validation.warnings.forEach((warning) => {
          send({ type: "warning", message: warning });
        });

        // Step 4: Generate session and layout
        send({ type: "progress", message: "Generating diagram..." });
        const sessionId = generateSessionId();
        const { nodes, edges } = ermodelToReactFlow(ermodel);
        const { nodes: layoutedNodes, edges: layoutedEdges } = applyDagreLayout(
          nodes,
          edges,
          "LR"
        );

        // Step 5: Send complete result
        send({
          type: "complete",
          data: {
            success: true,
            sessionId,
            ermodel,
            nodes: layoutedNodes,
            edges: layoutedEdges,
          },
        });

        controller.close();
      } catch (error) {
        send({
          type: "error",
          error:
            error instanceof Error ? error.message : "An error occurred",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

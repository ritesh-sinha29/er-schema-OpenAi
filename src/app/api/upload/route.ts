import { NextRequest, NextResponse } from "next/server";
import {
  generateSessionId,
  ermodelToReactFlow,
  applyDagreLayout,
  validateERModel,
} from "@/modules/my-project/ErHelper";
import { parseSchemaWithOpenAI } from "@/lib/openai";

export const maxDuration = 180;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { schemaContent } = body;

    if (!schemaContent || typeof schemaContent !== "string") {
      return NextResponse.json(
        { success: false, error: "Schema content is required" },
        { status: 400 }
      );
    }

    if (schemaContent.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "Schema content cannot be empty" },
        { status: 400 }
      );
    }

    // Parse schema with OpenAI
    console.log("Parsing schema with OpenAI...");
    let ermodel;
    try {
      ermodel = await parseSchemaWithOpenAI(schemaContent);
    } catch (error: unknown) {
      console.error("OpenAI parsing failed:", error);
      return NextResponse.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to parse schema. Please check the format and try again.",
        },
        { status: 500 }
      );
    }

    // Validate ERModel
    const validation = validateERModel(ermodel);
    if (!validation.valid) {
      console.error("ERModel validation failed:", validation.errors);
      return NextResponse.json(
        {
          success: false,
          error: `Schema validation failed: ${validation.errors.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Log warnings (non-blocking)
    if (validation.warnings.length > 0) {
      console.warn("ERModel validation warnings:", validation.warnings);
    }

    // Generate session ID
    const sessionId = generateSessionId();
    console.log(`Session created: ${sessionId}`);

    // Convert to React Flow format
    const { nodes, edges } = ermodelToReactFlow(ermodel);

    // Apply layout algorithm
    const { nodes: layoutedNodes, edges: layoutedEdges } = applyDagreLayout(
      nodes,
      edges,
      "LR"
    );

    // Return success response
    return NextResponse.json({
      success: true,
      sessionId,
      ermodel,
      nodes: layoutedNodes,
      edges: layoutedEdges,
    });
  } catch (error: unknown) {
    console.error("Upload route error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
      },
      { status: 500 }
    );
  }
}
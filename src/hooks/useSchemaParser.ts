import { useState, useCallback } from "react";
import type { ERModel, EntityNode, EntityEdge } from "@/types/ERmodel";

interface ParseResult {
  success: boolean;
  sessionId?: string;
  ermodel?: ERModel;
  nodes?: EntityNode[];
  edges?: EntityEdge[];
  error?: string;
}

interface StreamingState {
  isStreaming: boolean;
  progress: string[];
  warnings: string[];
  format: string | null;
  error: string | null;
  result: ParseResult | null;
}

export function useSchemaParser() {
  const [state, setState] = useState<StreamingState>({
    isStreaming: false,
    progress: [],
    warnings: [],
    format: null,
    error: null,
    result: null,
  });

  const parseSchema = useCallback(async (schemaContent: string) => {
    setState({
      isStreaming: true,
      progress: [],
      warnings: [],
      format: null,
      error: null,
      result: null,
    });

    try {
      const response = await fetch("/api/parse-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaContent }),
      });

      if (!response.ok) {
        throw new Error("Stream failed to start");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          try {
            const message = JSON.parse(line);

            switch (message.type) {
              case "progress":
                setState((prev) => ({
                  ...prev,
                  progress: [...prev.progress, message.message],
                }));
                break;

              case "format":
                setState((prev) => ({
                  ...prev,
                  format: message.format,
                }));
                break;

              case "warning":
                setState((prev) => ({
                  ...prev,
                  warnings: [...prev.warnings, message.message],
                }));
                break;

              case "complete":
                setState((prev) => ({
                  ...prev,
                  isStreaming: false,
                  result: message.data,
                }));
                break;

              case "error":
                setState((prev) => ({
                  ...prev,
                  isStreaming: false,
                  error: message.error,
                }));
                break;
            }
          } catch (parseError) {
            console.error("Failed to parse stream message:", parseError);
          }
        }
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        error:
          error instanceof Error ? error.message : "An error occurred",
      }));
    }
  }, []);

  const reset = useCallback(() => {
    setState({
      isStreaming: false,
      progress: [],
      warnings: [],
      format: null,
      error: null,
      result: null,
    });
  }, []);

  return {
    ...state,
    parseSchema,
    reset,
  };
}

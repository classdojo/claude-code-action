#!/usr/bin/env bun

import type { Octokit } from "@octokit/rest";
import type { ParsedGitHubContext } from "./github/context";
import type { OutputStrategy, ReviewContent } from "./output-strategies/base";
import { PrCommentStrategy } from "./output-strategies/pr-comment";
import { CommitCommentStrategy } from "./output-strategies/commit-comment";
import { StdoutStrategy } from "./output-strategies/stdout";

export interface OutputIdentifiers {
  [strategyName: string]: string | null;
}

export class OutputManager {
  private strategies: OutputStrategy[] = [];

  constructor(
    outputModes: string[],
    octokit: Octokit | null,
    context: ParsedGitHubContext,
    commitSha?: string,
  ) {
    // Create and validate strategies based on output modes
    for (const mode of outputModes) {
      const trimmedMode = mode.trim();
      let strategy: OutputStrategy;

      switch (trimmedMode) {
        case "pr_comment":
          if (!octokit) {
            throw new Error(
              "'pr_comment' output mode requires GitHub authentication (octokit instance)",
            );
          }
          strategy = new PrCommentStrategy(octokit);
          break;
        case "commit_comment":
          if (!octokit) {
            throw new Error(
              "'commit_comment' output mode requires GitHub authentication (octokit instance)",
            );
          }
          strategy = new CommitCommentStrategy(octokit, commitSha);
          break;
        case "stdout":
          strategy = new StdoutStrategy();
          break;
        default:
          throw new Error(
            `Unknown output mode: ${trimmedMode}. Valid options: pr_comment, commit_comment, stdout`,
          );
      }

      // Validate the strategy can work in this context
      try {
        strategy.validate(context);
        this.strategies.push(strategy);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Output mode '${trimmedMode}' validation failed: ${errorMessage}`,
        );
      }
    }

    if (this.strategies.length === 0) {
      throw new Error("No valid output strategies configured");
    }

    console.log(
      `📤 Configured output strategies: ${this.strategies.map((s) => s.name).join(", ")}`,
    );
  }

  static parseOutputModes(outputModeInput: string): string[] {
    if (!outputModeInput || outputModeInput.trim() === "") {
      return ["pr_comment"]; // Default
    }

    const modes = outputModeInput
      .split(",")
      .map((mode) => mode.trim())
      .filter((mode) => mode.length > 0);

    if (modes.length === 0) {
      return ["pr_comment"]; // Default
    }

    // Remove duplicates while preserving order
    return [...new Set(modes)];
  }

  async createInitial(
    context: ParsedGitHubContext,
  ): Promise<OutputIdentifiers> {
    const identifiers: OutputIdentifiers = {};
    const errors: Error[] = [];

    for (const strategy of this.strategies) {
      try {
        const identifier = await strategy.createInitial(context);
        identifiers[strategy.name] = identifier;
      } catch (error) {
        console.error(
          `❌ Output strategy ${strategy.name} failed during createInitial:`,
          error,
        );
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        errors.push(errorObj);
        identifiers[strategy.name] = null;
      }
    }

    // If all strategies failed during initial creation, that's a problem
    if (errors.length === this.strategies.length) {
      const lastError = errors[errors.length - 1];
      throw new Error(
        `All output strategies failed during initial creation. Last error: ${lastError?.message || "Unknown error"}`,
      );
    }

    return identifiers;
  }

  async updateFinal(
    identifiers: OutputIdentifiers,
    context: ParsedGitHubContext,
    content: ReviewContent,
  ): Promise<void> {
    const errors: Error[] = [];

    for (const strategy of this.strategies) {
      try {
        const identifier = identifiers[strategy.name] || null;
        await strategy.updateFinal(identifier, context, content);
      } catch (error) {
        console.error(
          `❌ Output strategy ${strategy.name} failed during updateFinal:`,
          error,
        );
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        errors.push(errorObj);
      }
    }

    // If all strategies failed, throw an error to mark the action as failed
    if (errors.length === this.strategies.length) {
      throw new Error(
        `All ${this.strategies.length} output strategies failed. See logs for details.`,
      );
    }

    // If some strategies failed but others succeeded, log a warning
    if (errors.length > 0) {
      console.warn(
        `⚠️ ${errors.length} of ${this.strategies.length} output strategies failed, but action completed partially.`,
      );
    }
  }

  /**
   * Gets the primary identifier for legacy compatibility.
   * Returns the first non-null identifier, preferring pr_comment.
   */
  getPrimaryIdentifier(identifiers: OutputIdentifiers): string | null {
    // Prefer pr_comment for backward compatibility
    if (identifiers.pr_comment) {
      return identifiers.pr_comment;
    }

    // Otherwise return the first non-null identifier
    for (const [, identifier] of Object.entries(identifiers)) {
      if (identifier) {
        return identifier;
      }
    }

    return null;
  }

  /**
   * Serializes identifiers to a JSON string for GITHUB_OUTPUT
   */
  serializeIdentifiers(identifiers: OutputIdentifiers): string {
    return JSON.stringify(identifiers);
  }

  /**
   * Deserializes identifiers from a JSON string from GITHUB_OUTPUT
   */
  static deserializeIdentifiers(serialized: string): OutputIdentifiers {
    if (!serialized || serialized.trim() === "") {
      return {};
    }

    try {
      return JSON.parse(serialized);
    } catch (error) {
      console.warn(
        "Failed to parse identifiers JSON, treating as empty:",
        error,
      );
      return {};
    }
  }
}

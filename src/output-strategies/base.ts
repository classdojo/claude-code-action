#!/usr/bin/env bun

import type { ParsedGitHubContext } from "../github/context";
import type { ExecutionDetails } from "../github/operations/comment-logic";

export interface ReviewContent {
  summary: string;
  body: string;
  actionFailed: boolean;
  executionDetails: ExecutionDetails | null;
  jobUrl: string;
  branchLink?: string;
  prLink?: string;
  branchName?: string;
  triggerUsername?: string;
  errorDetails?: string;
}

export interface OutputStrategy {
  readonly name: string;

  /**
   * Creates an initial placeholder/tracking entity if needed.
   * Returns an identifier (like a comment ID) for future updates.
   */
  createInitial(context: ParsedGitHubContext): Promise<string | null>;

  /**
   * Updates the entity with the final content.
   */
  updateFinal(
    identifier: string | null,
    context: ParsedGitHubContext,
    content: ReviewContent,
  ): Promise<void>;

  /**
   * Validates if this strategy can be used in the given context.
   */
  validate(context: ParsedGitHubContext): void;
}

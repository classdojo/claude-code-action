#!/usr/bin/env bun

import type { Octokit } from "@octokit/rest";
import { appendFileSync } from "fs";
import {
  createJobRunLink,
  createCommentBody,
} from "../github/operations/comments/common";
import { updateCommentBody } from "../github/operations/comment-logic";
import {
  isPullRequestReviewCommentEvent,
  type ParsedGitHubContext,
} from "../github/context";
import type { OutputStrategy, ReviewContent } from "./base";

export class PrCommentStrategy implements OutputStrategy {
  readonly name = "pr_comment";

  constructor(private octokit: Octokit) {}

  validate(context: ParsedGitHubContext): void {
    // PR comment strategy works for both issues and PRs
    if (!context.entityNumber) {
      throw new Error(
        "'pr_comment' output mode requires an issue or PR number",
      );
    }
  }

  async createInitial(context: ParsedGitHubContext): Promise<string | null> {
    const { owner, repo } = context.repository;
    const jobRunLink = createJobRunLink(owner, repo, context.runId);
    const initialBody = createCommentBody(jobRunLink);

    try {
      let response;

      // Only use createReplyForReviewComment if it's a PR review comment AND we have a comment_id
      if (isPullRequestReviewCommentEvent(context)) {
        response = await this.octokit.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: context.entityNumber,
          comment_id: context.payload.comment.id,
          body: initialBody,
        });
      } else {
        // For all other cases (issues, issue comments, or missing comment_id)
        response = await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: context.entityNumber,
          body: initialBody,
        });
      }

      // Output the comment ID for downstream steps using GITHUB_OUTPUT
      const githubOutput = process.env.GITHUB_OUTPUT!;
      appendFileSync(githubOutput, `claude_comment_id=${response.data.id}\n`);
      console.log(`✅ Created initial comment with ID: ${response.data.id}`);
      return response.data.id.toString();
    } catch (error) {
      console.error("Error in initial comment:", error);

      // Always fall back to regular issue comment if anything fails
      try {
        const response = await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: context.entityNumber,
          body: initialBody,
        });

        const githubOutput = process.env.GITHUB_OUTPUT!;
        appendFileSync(githubOutput, `claude_comment_id=${response.data.id}\n`);
        console.log(`✅ Created fallback comment with ID: ${response.data.id}`);
        return response.data.id.toString();
      } catch (fallbackError) {
        console.error("Error creating fallback comment:", fallbackError);
        throw fallbackError;
      }
    }
  }

  async updateFinal(
    identifier: string | null,
    context: ParsedGitHubContext,
    content: ReviewContent,
  ): Promise<void> {
    if (!identifier) {
      throw new Error("Cannot update comment without identifier");
    }

    const commentId = parseInt(identifier);
    const { owner, repo } = context.repository;

    // Use the existing comment body formatting logic
    const updatedBody = updateCommentBody({
      currentBody: content.body,
      actionFailed: content.actionFailed,
      executionDetails: content.executionDetails,
      jobUrl: content.jobUrl,
      branchLink: content.branchLink,
      prLink: content.prLink,
      branchName: content.branchName,
      triggerUsername: content.triggerUsername,
      errorDetails: content.errorDetails,
    });

    try {
      // Try PR review comment API first if it's a PR review comment
      if (isPullRequestReviewCommentEvent(context)) {
        await this.octokit.rest.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: commentId,
          body: updatedBody,
        });
      } else {
        // Use issue comment API (works for both issues and PR general comments)
        await this.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body: updatedBody,
        });
      }

      console.log(`✅ Updated comment with ID: ${commentId}`);
    } catch (error: any) {
      // If PR review comment update fails with 404, fall back to issue comment API
      if (isPullRequestReviewCommentEvent(context) && error.status === 404) {
        await this.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body: updatedBody,
        });
        console.log(`✅ Updated comment with ID: ${commentId} (fallback)`);
      } else {
        throw error;
      }
    }
  }
}

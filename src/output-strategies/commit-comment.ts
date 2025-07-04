#!/usr/bin/env bun

import type { Octokit } from "@octokit/rest";
import type { ParsedGitHubContext } from "../github/context";
import type { OutputStrategy, ReviewContent } from "./base";

export class CommitCommentStrategy implements OutputStrategy {
  readonly name = "commit_comment";

  constructor(private octokit: Octokit, private commitSha?: string) {}

  validate(context: ParsedGitHubContext): void {
    const sha = this.getCommitSha(context);
    if (!sha) {
      throw new Error(
        "'commit_comment' output mode requires a determinable commit SHA (provide commit_sha input, or use in pull_request/push context)"
      );
    }
  }

  private getCommitSha(context: ParsedGitHubContext): string | null {
    // 1. Use explicit commit_sha if provided
    if (this.commitSha) {
      return this.commitSha;
    }

    // 2. Use PR HEAD commit if in PR context
    if ('pull_request' in context.payload && context.payload.pull_request?.head?.sha) {
      return context.payload.pull_request.head.sha;
    }

    // 3. Use workflow commit SHA
    if ('after' in context.payload && context.payload.after) {
      return context.payload.after;
    }

    // 4. Use github.sha as fallback
    return process.env.GITHUB_SHA || null;
  }

  async createInitial(_context: ParsedGitHubContext): Promise<string | null> {
    // Commit comments cannot be updated, so we don't create initial placeholder
    console.log("📝 Preparing to create commit comment...");
    return null;
  }

  async updateFinal(
    _identifier: string | null,
    context: ParsedGitHubContext,
    content: ReviewContent
  ): Promise<void> {
    const sha = this.getCommitSha(context);
    if (!sha) {
      throw new Error("Cannot create commit comment without commit SHA");
    }

    const { owner, repo } = context.repository;

    // Format content for commit comment (plain text, no markdown links)
    const commentBody = this.formatForCommitComment(content);

    try {
      const response = await this.octokit.rest.repos.createCommitComment({
        owner,
        repo,
        commit_sha: sha,
        body: commentBody,
      });

      console.log(`✅ Created commit comment on ${sha.substring(0, 7)}: ${response.data.html_url}`);
    } catch (error) {
      console.error(`Error creating commit comment on ${sha}:`, error);
      throw error;
    }
  }

  private formatForCommitComment(content: ReviewContent): string {
    const lines: string[] = [];

    // Header
    if (content.actionFailed) {
      lines.push("🚨 Claude Code encountered an error");
    } else {
      const username = content.triggerUsername || "user";
      lines.push(`✅ Claude Code completed @${username}'s task`);
    }

    // Duration info
    if (content.executionDetails?.duration_ms) {
      const totalSeconds = Math.round(content.executionDetails.duration_ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      lines.push(`⏱️ Duration: ${durationStr}`);
    }

    // Links
    lines.push(`🔗 Job: ${content.jobUrl}`);
    if (content.branchName) {
      lines.push(`🌿 Branch: ${content.branchName}`);
    }
    if (content.prLink) {
      // Extract URL from markdown link
      const urlMatch = content.prLink.match(/\(([^)]+)\)/);
      if (urlMatch) {
        lines.push(`📥 PR: ${urlMatch[1]}`);
      }
    }

    lines.push(""); // Empty line before content

    // Error details
    if (content.actionFailed && content.errorDetails) {
      lines.push("Error details:");
      lines.push(content.errorDetails);
      lines.push(""); // Empty line after error
    }

    // Main content (strip existing header/footer formatting)
    let mainContent = content.body;
    
    // Remove "Claude Code is working..." pattern
    mainContent = mainContent.replace(/Claude Code is working[…\.]{1,3}(?:\s*<img[^>]*>)?/i, "").trim();
    
    // Remove existing job/branch links
    mainContent = mainContent.replace(/\[View job\]\([^\)]+\)/g, "");
    mainContent = mainContent.replace(/\[View branch\]\([^\)]+\)/g, "");
    mainContent = mainContent.replace(/\[Create .* PR\]\([^\)]+\)/g, "");
    
    // Remove separator lines
    mainContent = mainContent.replace(/\n*---\n*/g, "");
    
    // Clean up extra whitespace
    mainContent = mainContent.trim();

    if (mainContent) {
      lines.push(mainContent);
    }

    return lines.join("\n");
  }
}
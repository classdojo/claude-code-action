#!/usr/bin/env bun

import type { ParsedGitHubContext } from "../github/context";
import type { OutputStrategy, ReviewContent } from "./base";

export class StdoutStrategy implements OutputStrategy {
  readonly name = "stdout";

  validate(_context: ParsedGitHubContext): void {
    // stdout strategy works in any context
  }

  async createInitial(_context: ParsedGitHubContext): Promise<string | null> {
    console.log("🤖 Starting Claude Code review...");
    return null;
  }

  async updateFinal(
    _identifier: string | null,
    _context: ParsedGitHubContext,
    content: ReviewContent,
  ): Promise<void> {
    const output = this.formatForStdout(content);

    console.log(""); // Empty line before output
    console.log("=".repeat(60));
    console.log("Claude Code Review Summary");
    console.log("=".repeat(60));
    console.log(output);
    console.log("=".repeat(60));
  }

  private formatForStdout(content: ReviewContent): string {
    const lines: string[] = [];

    // Status
    if (content.actionFailed) {
      lines.push("Status: FAILED");
    } else {
      lines.push("Status: COMPLETED");
    }

    // Duration
    if (content.executionDetails?.duration_ms) {
      const totalSeconds = Math.round(
        content.executionDetails.duration_ms / 1000,
      );
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const durationStr =
        minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      lines.push(`Duration: ${durationStr}`);
    }

    // Cost
    if (content.executionDetails?.cost_usd) {
      lines.push(`Cost: $${content.executionDetails.cost_usd.toFixed(4)}`);
    }

    // User
    if (content.triggerUsername) {
      lines.push(`Triggered by: @${content.triggerUsername}`);
    }

    // Links
    lines.push(`Job URL: ${content.jobUrl}`);
    if (content.branchName) {
      lines.push(`Branch: ${content.branchName}`);
    }
    if (content.prLink) {
      // Extract URL from markdown link
      const urlMatch = content.prLink.match(/\(([^)]+)\)/);
      if (urlMatch) {
        lines.push(`PR URL: ${urlMatch[1]}`);
      }
    }

    lines.push(""); // Empty line before content

    // Error details
    if (content.actionFailed && content.errorDetails) {
      lines.push("ERROR DETAILS:");
      lines.push("-".repeat(40));
      lines.push(content.errorDetails);
      lines.push("-".repeat(40));
      lines.push(""); // Empty line after error
    }

    // Main content (convert markdown to plain text)
    let mainContent = content.body;

    // Remove "Claude Code is working..." pattern
    mainContent = mainContent
      .replace(/Claude Code is working[…\.]{1,3}(?:\s*<img[^>]*>)?/i, "")
      .trim();

    // Convert markdown to plain text
    mainContent = this.markdownToPlainText(mainContent);

    // Remove existing job/branch links
    mainContent = mainContent.replace(/\[View job\]\([^\)]+\)/g, "");
    mainContent = mainContent.replace(/\[View branch\]\([^\)]+\)/g, "");
    mainContent = mainContent.replace(/\[Create .* PR\]\([^\)]+\)/g, "");

    // Remove separator lines
    mainContent = mainContent.replace(/\n*---\n*/g, "");

    // Clean up extra whitespace
    mainContent = mainContent.trim();

    if (mainContent) {
      lines.push("CONTENT:");
      lines.push("-".repeat(40));
      lines.push(mainContent);
    }

    return lines.join("\n");
  }

  private markdownToPlainText(markdown: string): string {
    return (
      markdown
        // Remove markdown links but keep URL
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
        // Remove bold/italic
        .replace(/\*\*([^*]*)\*\*/g, "$1")
        .replace(/\*([^*]*)\*/g, "$1")
        // Remove code blocks
        .replace(/```[\s\S]*?```/g, "[CODE BLOCK]")
        // Remove inline code
        .replace(/`([^`]*)`/g, "$1")
        // Remove headers
        .replace(/^#{1,6}\s+(.*)$/gm, "$1")
        // Clean up multiple newlines
        .replace(/\n{3,}/g, "\n\n")
    );
  }
}

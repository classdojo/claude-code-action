#!/usr/bin/env bun

import { createOctokit } from "../github/api/client";
import * as fs from "fs/promises";
import { type ExecutionDetails } from "../github/operations/comment-logic";
import { parseGitHubContext } from "../github/context";
import { GITHUB_SERVER_URL } from "../github/api/config";
import { checkAndDeleteEmptyBranch } from "../github/operations/branch-cleanup";
import { OutputManager, type OutputIdentifiers } from "../output-manager";
import type { ReviewContent } from "../output-strategies/base";

async function run() {
  try {
    // Legacy fallback for claude_comment_id
    const legacyCommentId = process.env.CLAUDE_COMMENT_ID;
    const outputIdentifiersJson = process.env.OUTPUT_IDENTIFIERS;
    const githubToken = process.env.GITHUB_TOKEN!;
    const claudeBranch = process.env.CLAUDE_BRANCH;
    const baseBranch = process.env.BASE_BRANCH || "main";
    const triggerUsername = process.env.TRIGGER_USERNAME;
    const outputModes = OutputManager.parseOutputModes(
      process.env.OUTPUT_MODE || "pr_comment",
    );
    const commitSha = process.env.COMMIT_SHA;

    const context = parseGitHubContext();
    const { owner, repo } = context.repository;
    const octokit = createOctokit(githubToken);

    // Parse output identifiers from prepare step or fall back to legacy
    let outputIdentifiers: OutputIdentifiers;
    if (outputIdentifiersJson) {
      outputIdentifiers = OutputManager.deserializeIdentifiers(
        outputIdentifiersJson,
      );
    } else if (legacyCommentId) {
      // Legacy fallback - assume pr_comment mode
      outputIdentifiers = { pr_comment: legacyCommentId };
    } else {
      outputIdentifiers = {};
    }

    // Create output manager for final update
    const outputManager = new OutputManager(
      outputModes,
      octokit.rest,
      context,
      commitSha,
    );

    const serverUrl = GITHUB_SERVER_URL;
    const jobUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

    // For legacy support, we still need to fetch the current body if we have a pr_comment identifier
    let currentBody = "";
    if (outputIdentifiers.pr_comment) {
      try {
        const commentId = parseInt(outputIdentifiers.pr_comment);
        // Try to fetch the current comment body for the update
        try {
          const { data: issueComment } = await octokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: commentId,
          });
          currentBody = issueComment.body ?? "";
        } catch {
          // If issue comment fails, try PR review comment
          const { data: prComment } = await octokit.rest.pulls.getReviewComment(
            {
              owner,
              repo,
              comment_id: commentId,
            },
          );
          currentBody = prComment.body ?? "";
        }
      } catch (error) {
        console.warn(
          "Could not fetch current comment body, proceeding with empty body:",
          error,
        );
      }
    }

    // Check if we need to add branch link for new branches
    const { shouldDeleteBranch, branchLink } = await checkAndDeleteEmptyBranch(
      octokit,
      owner,
      repo,
      claudeBranch,
      baseBranch,
    );

    // Check if we need to add PR URL when we have a new branch
    let prLink = "";
    // If claudeBranch is set, it means we created a new branch (for issues or closed/merged PRs)
    if (claudeBranch && !shouldDeleteBranch) {
      // Check if comment already contains a PR URL
      const serverUrlPattern = serverUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prUrlPattern = new RegExp(
        `${serverUrlPattern}\\/.+\\/compare\\/${baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\.\\.`,
      );
      const containsPRUrl = currentBody.match(prUrlPattern);

      if (!containsPRUrl) {
        // Check if there are changes to the branch compared to the default branch
        try {
          const { data: comparison } =
            await octokit.rest.repos.compareCommitsWithBasehead({
              owner,
              repo,
              basehead: `${baseBranch}...${claudeBranch}`,
            });

          // If there are changes (commits or file changes), add the PR URL
          if (
            comparison.total_commits > 0 ||
            (comparison.files && comparison.files.length > 0)
          ) {
            const entityType = context.isPR ? "PR" : "Issue";
            const prTitle = encodeURIComponent(
              `${entityType} #${context.entityNumber}: Changes from Claude`,
            );
            const prBody = encodeURIComponent(
              `This PR addresses ${entityType.toLowerCase()} #${context.entityNumber}\n\nGenerated with [Claude Code](https://claude.ai/code)`,
            );
            const prUrl = `${serverUrl}/${owner}/${repo}/compare/${baseBranch}...${claudeBranch}?quick_pull=1&title=${prTitle}&body=${prBody}`;
            prLink = `\n[Create a PR](${prUrl})`;
          }
        } catch (error) {
          console.error("Error checking for changes in branch:", error);
          // Don't fail the entire update if we can't check for changes
        }
      }
    }

    // Check if action failed and read output file for execution details
    let executionDetails: ExecutionDetails | null = null;
    let actionFailed = false;
    let errorDetails: string | undefined;

    // First check if prepare step failed
    const prepareSuccess = process.env.PREPARE_SUCCESS !== "false";
    const prepareError = process.env.PREPARE_ERROR;

    if (!prepareSuccess && prepareError) {
      actionFailed = true;
      errorDetails = prepareError;
    } else {
      // Check for existence of output file and parse it if available
      try {
        const outputFile = process.env.OUTPUT_FILE;
        if (outputFile) {
          const fileContent = await fs.readFile(outputFile, "utf8");
          const outputData = JSON.parse(fileContent);

          // Output file is an array, get the last element which contains execution details
          if (Array.isArray(outputData) && outputData.length > 0) {
            const lastElement = outputData[outputData.length - 1];
            if (
              lastElement.type === "result" &&
              "cost_usd" in lastElement &&
              "duration_ms" in lastElement
            ) {
              executionDetails = {
                cost_usd: lastElement.cost_usd,
                duration_ms: lastElement.duration_ms,
                duration_api_ms: lastElement.duration_api_ms,
              };
            }
          }
        }

        // Check if the Claude action failed
        const claudeSuccess = process.env.CLAUDE_SUCCESS !== "false";
        actionFailed = !claudeSuccess;
      } catch (error) {
        console.error("Error reading output file:", error);
        // If we can't read the file, check for any failure markers
        actionFailed = process.env.CLAUDE_SUCCESS === "false";
      }
    }

    // Prepare content for all output strategies
    const reviewContent: ReviewContent = {
      summary: actionFailed ? "Action failed" : "Action completed",
      body: currentBody,
      actionFailed,
      executionDetails,
      jobUrl,
      branchLink,
      prLink,
      branchName: shouldDeleteBranch ? undefined : claudeBranch,
      triggerUsername,
      errorDetails,
    };

    // Use OutputManager to update all configured output strategies
    await outputManager.updateFinal(outputIdentifiers, context, reviewContent);
    console.log("✅ Updated all configured output strategies");

    process.exit(0);
  } catch (error) {
    console.error("Error updating comment with job link:", error);
    process.exit(1);
  }
}

run();

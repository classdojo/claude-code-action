import * as core from "@actions/core";

export async function prepareMcpConfig(
  githubToken: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  console.log("Preparing MCP config ", {
    githubToken: !!githubToken,
    slackBotToken: !!process.env.SLACK_BOT_TOKEN,
  });

  try {
    const mcpConfig = {
      mcpServers: {
        github: {
          command: "docker",
          args: [
            "run",
            "-i",
            "--rm",
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/anthropics/github-mcp-server:sha-7382253",
          ],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
          },
        },
        github_file_ops: {
          command: "bun",
          args: [
            "run",
            `${process.env.GITHUB_ACTION_PATH}/src/mcp/github-file-ops-server.ts`,
          ],
          env: {
            GITHUB_TOKEN: githubToken,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            BRANCH_NAME: branch,
          },
        },
        ...(process.env.SLACK_BOT_TOKEN && process.env.SLACK_TEAM_ID
          ? {
              slack: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-slack"],
                env: {
                  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
                  SLACK_TEAM_ID: process.env.SLACK_TEAM_ID,
                  SLACK_CHANNEL_IDS: process.env.SLACK_CHANNEL_IDS || "",
                },
              },
            }
          : {}),
      },
    };

    return JSON.stringify(mcpConfig, null, 2);
  } catch (error) {
    core.setFailed(`Install MCP server failed with error: ${error}`);
    process.exit(1);
  }
}

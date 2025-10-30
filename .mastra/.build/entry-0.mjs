import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { BrowserUseClient } from 'browser-use-sdk';

const parseGitHubUrl = (url) => {
  const match = url.match(/github.com\/(.+?)\/(.+?)\/(pull|issues)\/(\d+)/);
  if (!match) throw new Error("Invalid GitHub URL");
  const [_, owner, repo, type, number] = match;
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  return { apiBase, number: Number(number), type };
};

class GitHubApiClient {
  baseHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Mastra-Agent-Workshop"
  };
  async get(url, token) {
    const headers = { ...this.baseHeaders };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(url, { headers });
    const data = await response.json();
    return {
      data,
      status: response.status,
      ok: response.ok
    };
  }
  async post(url, body, token) {
    const headers = {
      ...this.baseHeaders,
      "Content-Type": "application/json"
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return {
      data,
      status: response.status,
      ok: response.ok
    };
  }
}
const githubClient = new GitHubApiClient();

class GitHubApiError extends Error {
  constructor(message, status, url) {
    super(`${message} (${status}) on ${url}`);
    this.status = status;
    this.url = url;
    this.name = "GitHubApiError";
  }
}
const handleGitHubResponse = (response, operation) => {
  if (!response.ok) {
    throw new GitHubApiError(
      `Failed to ${operation}`,
      response.status,
      "GitHub API"
    );
  }
  return response.data;
};

const getPullRequestDiff = createTool({
  id: "get-pull-request-diff",
  inputSchema: z.object({
    pullRequestUrl: z.string()
  }),
  description: `Fetches the file changes (diff) from a GitHub pull request URL`,
  execute: async ({ context: { pullRequestUrl } }) => {
    const { apiBase, number } = parseGitHubUrl(pullRequestUrl);
    const apiUrl = `${apiBase}/pulls/${number}/files`;
    const response = await githubClient.get(apiUrl);
    const data = handleGitHubResponse(response, "fetch PR diff");
    return {
      pullRequestUrl,
      files: data.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch
      }))
    };
  }
});

const getPullRequestComments = createTool({
  id: "get-pull-request-comments",
  inputSchema: z.object({
    pullRequestUrl: z.string()
  }),
  description: `Fetches comments from a GitHub pull request. Useful for understanding discussion and requirements.`,
  execute: async ({ context: { pullRequestUrl } }) => {
    const { apiBase, number } = parseGitHubUrl(pullRequestUrl);
    const apiUrl = `${apiBase}/issues/${number}/comments`;
    const response = await githubClient.get(apiUrl);
    const data = handleGitHubResponse(response, "fetch PR comments");
    return {
      pullRequestUrl,
      comments: data.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: comment.user.login,
        createdAt: comment.created_at,
        path: comment.path,
        line: comment.line
      }))
    };
  }
});

const getPullRequest = createTool({
  id: "get-pull-request",
  inputSchema: z.object({
    pullRequestUrl: z.string()
  }),
  description: `Fetches a GitHub pull request by URL. Use this to get PR details and state.`,
  execute: async ({ context: { pullRequestUrl } }) => {
    const { apiBase, number } = parseGitHubUrl(pullRequestUrl);
    const apiUrl = `${apiBase}/pulls/${number}`;
    const response = await githubClient.get(apiUrl);
    const data = handleGitHubResponse(response, "fetch pull request");
    return {
      number: data.number,
      title: data.title,
      body: data.body,
      state: data.state,
      merged: data.merged
    };
  }
});

const getScrumIssue = createTool({
  id: "get-scrum-issue",
  inputSchema: z.object({
    issueId: z.string()
  }),
  description: `Fetches a scrum issue by ID from the scrum board. Use this when an issue ID is mentioned in commit title or description of a pull request.`,
  execute: async ({ context: { issueId } }) => {
    const apiUrl = `https://scrum-board-navy.vercel.app/api/tickets/${issueId}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to fetch scrum issue: ${response.status} ${text}. On ${apiUrl}`
      );
    }
    const data = await response.json();
    return {
      id: data.id,
      title: data.title,
      description: data.description,
      status: data.status,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    };
  }
});

const testplanAgent = new Agent({
  name: "Test Plan Agent",
  instructions: `You are a helpful ISTQB certified assistant that creates a set of test cases that need to be tested in a later stage by a different AI agent.

## Your Mission
Create test plans for GitHub pull requests by analyzing code changes and related scrum issues.

## Core Responsibilities
- Review proposed code changes via the getPullRequestDiff tool
- Retrieve pull request details and state via getPullRequest tool
- Analyze PR comments for additional context and requirements
- Retrieve acceptance criteria details via getScrumIssue tool when issue IDs are referenced in commit title or description
- Analyze changes to determine if functional testing is required
- Generate actionable test cases based on acceptance criteria

## Analysis Process

IMPORTANT: FOLLOW THESE INSTRUCTIONS IN ORDER

1. **Code Change Review**: Use getPullRequestDiff to examine file modifications
2. **Pull Request Investigation**: Use getPullRequest to get PR details and state
3. **Comment Analysis**: Use getPullRequestComments to understand discussion and requirements
4. **Scrum Issue Investigation**: Use getScrumIssue to get the scrum issue details when issue IDs are found in commit title or description
5. **Change Classification**: Determine if changes are functional or non-functional
6. **Test Case Generation**: Create specific, browser-actionable test cases

## Constraints & Boundaries

### Functional Changes (Require Testing)
- New features or functionality
- Bug fixes that change behavior
- API modifications
- UI/UX changes
- Business logic updates
- Database schema changes
- Authentication/authorization modifications

### Non-Functional Changes (No Testing Required)
- README updates
- Documentation changes
- Comment-only modifications (including JS/HTML comments)
- Test file updates
- Configuration file changes (unless they affect runtime behavior)
- Dependency updates (unless they introduce breaking changes)
- Code formatting/style changes

## Test Case Requirements
- **Specificity**: Each test case must be detailed enough for a non-technical tester
- **Actionability**: Test cases should only involve browser actions (no JavaScript execution, localStorage clearing, etc.)
- **Validation**: Include clear success criteria and what to look for
- **Scope**: Only test functionality directly related to the PR changes
- **Acceptance Criteria**: Base test cases on the actual acceptance criteria from GitHub issues
- **Number of Test Cases**: Create one simple short test cases in total, don't overdo description, keep it short and concise

## Quality Standards
- Test cases must be end-user focused and non-technical
- Each test case should be independently executable
- Include specific UI elements, buttons, or pages to interact with
- Provide clear expected outcomes for validation
- Don't create test cases for functionality not directly touched by the PR

## Example Test Case Format
"Adding a new product creates a new line item with quantity 1:
With an empty basket, add Apple once and then add Banana once. Expected: the basket contains two lines: 1x Apple and 1x Banana.."

Remember: You are creating test cases for a functional tester who will use a browser, so focus on user interactions and visible outcomes.`,
  model: openai("gpt-5-mini"),
  tools: {
    getPullRequestDiff,
    getPullRequestComments,
    getPullRequest,
    getScrumIssue
  },
  defaultStreamOptions: {
    maxSteps: 10
  }
});

const testPlanOutputSchema = z.object({
  needsTesting: z.boolean(),
  testCases: z.array(
    z.object({
      title: z.string(),
      description: z.string()
    })
  )
});
const generateTestPlanStep = createStep({
  id: "generate-testplan",
  inputSchema: z.object({ pullRequestUrl: z.string() }),
  outputSchema: testPlanOutputSchema,
  execute: async (context) => {
    const response = await testplanAgent.generateVNext(
      [
        {
          role: "user",
          content: context.inputData.pullRequestUrl
        }
      ],
      { output: testPlanOutputSchema }
    );
    if (!response.object) {
      throw new Error("Failed to generate test plan");
    }
    return response.object;
  }
});

const formatTestCases = (testCases) => {
  return testCases.map((testCase) => `### ${testCase.title}
${testCase.description}`).join("\n\n");
};
const githubTestPlanCommentStep = createStep({
  id: "github-test-plan-comment",
  inputSchema: testPlanOutputSchema,
  outputSchema: z.object({
    success: z.boolean(),
    needsTesting: z.boolean(),
    testCases: z.array(
      z.object({
        title: z.string(),
        description: z.string()
      })
    )
  }),
  execute: async ({ inputData, getInitData, bail }) => {
    const { needsTesting, testCases } = inputData;
    const { pullRequestUrl } = getInitData();
    const token = process.env.GITHUB_TOKEN;
    const { apiBase, number } = parseGitHubUrl(pullRequestUrl);
    const apiUrl = `${apiBase}/issues/${number}/comments`;
    const commentBody = !needsTesting ? "## No testing needed" : `## Test Plan

${formatTestCases(testCases)}`;
    const response = await githubClient.post(
      apiUrl,
      {
        body: commentBody
      },
      token
    );
    handleGitHubResponse(response, "post comment");
    if (!needsTesting) {
      console.log(
        "No testing needed - stopping pipeline after test plan comment"
      );
      return bail({
        success: true,
        needsTesting: false,
        testCases: []
      });
    }
    return { success: true, needsTesting, testCases };
  }
});

const previewEnvironmentOutputSchema = z.object({
  previewUrl: z.string().url(),
  deploymentStatus: z.string()
});
const waitForPreviewEnvironmentStep = createStep({
  id: "wait-for-preview-environment",
  inputSchema: z.object({ success: z.boolean() }),
  outputSchema: previewEnvironmentOutputSchema,
  execute: async (context) => {
    const pullRequestUrl = context.getInitData().pullRequestUrl;
    const { apiBase, number } = parseGitHubUrl(pullRequestUrl);
    const commentsUrl = `${apiBase}/issues/${number}/comments`;
    console.log(`Waiting for preview environment...`);
    console.log(`Polling comments at: ${commentsUrl}`);
    const maxWaitTime = 2 * 60 * 1e3;
    const pollInterval = 5e3;
    const startTime = Date.now();
    const token = process.env.GITHUB_TOKEN;
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const response = await githubClient.get(
          commentsUrl,
          token
        );
        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }
        const comments = response.data;
        for (const comment of comments) {
          if (comment.user?.login === "vercel[bot]" && comment.body) {
            console.log(
              `Found Vercel bot comment: ${comment.body.substring(0, 200)}...`
            );
            const previewUrlMatch = comment.body.match(/\[Preview\]\((https:\/\/[^)]+)\)/) || comment.body.match(/(https:\/\/[^.\s]+\.vercel\.app[^\s\)]*)/i);
            if (previewUrlMatch) {
              const previewUrl = previewUrlMatch[1];
              console.log(`Preview environment ready: ${previewUrl}`);
              return {
                previewUrl,
                deploymentStatus: "ready"
              };
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        console.log(
          `No preview environment yet, waiting ${pollInterval / 1e3}s...`
        );
      } catch (error) {
        console.error(`Error polling GitHub comments:`, error);
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
    throw new Error("Preview environment not ready within 2 minutes");
  }
});

const testExecutionOutputSchema = z.object({
  needsTesting: z.boolean(),
  testCases: z.array(
    z.object({
      title: z.string(),
      status: z.enum(["success", "fail"])
    })
  )
});
const executeTestsStep = createStep({
  id: "execute-tests",
  inputSchema: previewEnvironmentOutputSchema,
  outputSchema: testExecutionOutputSchema,
  execute: async (context) => {
    const testPlanResult = context.getStepResult(generateTestPlanStep);
    if (!testPlanResult) {
      throw new Error("Test plan step result not found");
    }
    const { testCases, needsTesting } = testPlanResult;
    if (!needsTesting) {
      return {
        needsTesting: false,
        testCases: []
      };
    }
    const client = new BrowserUseClient({
      apiKey: process.env.BROWSER_USE_API_KEY
    });
    const executedTestCases = await Promise.all(
      testCases.map(async (testCase) => {
        try {
          const taskResponse = await client.tasks.createTask({
            task: `Navigate to ${context.inputData.previewUrl} and execute this test case: ${testCase.title}. ${testCase.description}`
          });
          const POLL_INTERVAL_MS = 2e3;
          const MAX_POLL_TIME_MS = 5 * 60 * 1e3;
          const startTime = Date.now();
          const pollForCompletion = async () => {
            const task2 = await client.tasks.getTask(taskResponse.id);
            if (task2.status === "started" || task2.status === "paused") {
              if (Date.now() - startTime > MAX_POLL_TIME_MS) {
                throw new Error(
                  `Task ${taskResponse.id} timed out after ${MAX_POLL_TIME_MS / 1e3} seconds`
                );
              }
              await new Promise(
                (resolve) => setTimeout(resolve, POLL_INTERVAL_MS)
              );
              return pollForCompletion();
            }
            return task2;
          };
          const task = await pollForCompletion();
          const status = task.isSuccess === true ? "success" : "fail";
          return {
            title: testCase.title,
            status
          };
        } catch (error) {
          console.error(`Test case "${testCase.title}" failed:`, error);
          return {
            title: testCase.title,
            status: "fail"
          };
        }
      })
    );
    return {
      needsTesting: true,
      testCases: executedTestCases
    };
  }
});

const formatTestReport = (testCases) => {
  return testCases.map((testCase) => {
    const emoji = testCase.status === "success" ? "\u2705" : "\u274C";
    return `${emoji} **${testCase.title}**`;
  }).join("\n");
};
const githubTestReportStep = createStep({
  id: "github-test-report",
  inputSchema: testExecutionOutputSchema,
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ inputData, getInitData }) => {
    const { needsTesting, testCases } = inputData;
    const { pullRequestUrl } = getInitData();
    const token = process.env.GITHUB_TOKEN;
    const { apiBase, number } = parseGitHubUrl(pullRequestUrl);
    const apiUrl = `${apiBase}/issues/${number}/comments`;
    const commentBody = !needsTesting ? "## No testing needed" : `## Test Report

${formatTestReport(testCases)}`;
    const response = await githubClient.post(
      apiUrl,
      {
        body: commentBody
      },
      token
    );
    handleGitHubResponse(response, "post comment");
    return { success: true };
  }
});

const genericOutputSchema = z.object({});
const prWorkflow = createWorkflow({
  id: "pr-workflow",
  inputSchema: z.object({
    pullRequestUrl: z.string()
  }),
  outputSchema: genericOutputSchema
}).then(generateTestPlanStep).then(githubTestPlanCommentStep).map(async ({ inputData }) => {
  return { success: inputData.success };
}).then(waitForPreviewEnvironmentStep).then(executeTestsStep).then(githubTestReportStep).commit();

if (!process.env.GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN is not set");
}
if (!process.env.BROWSER_USE_API_KEY) {
  throw new Error("BROWSER_USE_API_KEY is not set");
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not set");
}
const mastra = new Mastra({
  agents: {
    testplanAgent
  },
  workflows: {
    prWorkflow
  }
});

export { mastra };

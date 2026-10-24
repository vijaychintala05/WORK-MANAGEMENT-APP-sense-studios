import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/generated/**",
      "**/.artifacts/**",
      "**/.env.*/**",
      // Preserved standalone design outputs and diagnostic scratch scripts are not application source.
      "docs/design/_build/**",
      "docs/v1-demo/task-create-refinement.js",
      "_allviews.js", "_av2.js", "_dump.js", "_probe.js", "_runtest.js", "_trace.js",
      ".scratch-visual/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs,cjs}"],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.jest,
        vi: "readonly"
      }
    }
  },
  {
    files: ["docs/ui/v1/mockup-interactions.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        $: "readonly",
        activeFilter: "writable",
        applyDensity: "readonly",
        body: "readonly",
        content: "readonly",
        currentScreenLabel: "readonly",
        density: "writable",
        docSearch: "writable",
        docStatus: "writable",
        documents: "readonly",
        escapeHtml: "readonly",
        globalDocs: "writable",
        go: "readonly",
        icon: "readonly",
        overview: "readonly",
        preview: "readonly",
        previewRole: "writable",
        projectHeader: "readonly",
        projectTaskFilter: "writable",
        projectTaskRows: "readonly",
        projectTaskSearch: "writable",
        projectTasks: "readonly",
        reviewDetail: "readonly",
        reviews: "readonly",
        screen: "writable",
        searchText: "writable",
        selectedTaskId: "writable",
        state: "writable",
        tag: "readonly",
        taskData: "readonly",
        taskRows: "readonly",
        taskView: "writable",
        work: "readonly"
      }
    },
  },
  {
    files: [
      "docs/ui/UX_VALIDATION_CHECK_2026-10-07.cjs",
      "docs/ui/UX_CAPABILITY_MAP_BUILD_2026-10-07.cjs",
      "docs/ui/UX_DASHBOARD_CHECK_2026-10-07.cjs",
      "docs/ui/UX_REFERO_REVISION_CHECK_2026-10-07.cjs",
      "docs/ui/people-review-2026-10-07/walkthrough.cjs"
    ],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        allowed: "readonly",
        features: "readonly",
        flows: "readonly",
        go: "readonly",
        actor: "writable",
        role: "writable",
        actionVisible: "readonly",
        tasks: "readonly",
        sampleTimer: "readonly",
        workforceEmployee: "readonly",
        decisionRecords: "readonly",
        project: "writable"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:", "^@playwright/test$"] }]
    }
  },
  {
    files: ["docs/ui/UX_INSIGHTS_ASSEMBLE_2026-10-08.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:fs$", "^node:path$"] }]
    }
  },
  {
    files: ["docs/ui/UX_INSIGHTS_*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
        actor: "writable",
        go: "readonly",
        insightsState: "readonly",
        irDefinitions: "readonly",
        irHandleAction: "readonly",
        irManifestAllowed: "readonly",
        irRuns: "readonly",
        irSnapshots: "readonly",
        irState: "readonly",
        ihGroups: "readonly",
        ihPolicies: "readonly",
        render: "readonly",
        role: "writable",
        tasks: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:", "^@playwright/test$"] }]
    }
  },
  {
    files: ["docs/ui/UX_MOBILE_*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:"] }]
    }
  },
  {
    files: ["docs/ui/UX_MOBILE_SHELL_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        createReturn: "writable",
        current: "writable",
        filter: "writable",
        mobileVariant: "writable",
        mode: "writable",
        permittedLinks: "readonly",
        reviewQueueFilter: "writable",
        tab: "writable",
        taskListContext: "writable",
        taskOrigin: "writable",
        taskScope: "writable",
        taskView: "writable",
        workMode: "writable"
      }
    }
  },
  {
    files: ["docs/ui/UX_MOBILE_WORKFLOWS_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, irState: "readonly" }
    }
  },
  {
    files: ["docs/ui/UX_INSIGHTS_POLICY_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        actor: "readonly",
        ihEsc: "readonly",
        ihHealthActions: "readonly",
        ihOwner: "readonly",
        ihPeople: "readonly",
        ihPerformanceActions: "readonly",
        insightsState: "readonly",
        render: "readonly",
        role: "readonly"
      }
    }
  },
  {
    files: ["docs/ui/UX_INSIGHTS_PERFORMANCE_HEALTH_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        currentDecisions: "readonly",
        decisionRecords: "readonly",
        ihPolicyRender: "readonly",
        actor: "readonly",
        attendancePunchId: "writable",
        canonicalReviews: "readonly",
        decisions: "readonly",
        esc: "readonly",
        gapActions: "readonly",
        go: "readonly",
        internal: "readonly",
        openProject: "readonly",
        openReview: "readonly",
        openTask: "readonly",
        owner: "readonly",
        people: "readonly",
        projects: "readonly",
        render: "readonly",
        revision: "readonly",
        role: "readonly",
        sampleProjectAccess: "readonly",
        taskAccessible: "readonly",
        taskId: "writable",
        tasks: "readonly",
        timeActivity: "writable",
        timeContextTask: "writable",
        timeEntries: "readonly",
        selectedTimeEntry: "writable"
      }
    }
  },
  {
    files: ["docs/ui/UX_INSIGHTS_REPORTS_SAVED_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        actor: "readonly",
        current: "writable",
        decisionRecords: "readonly",
        internal: "readonly",
        openExactDecision: "readonly",
        role: "readonly",
        openTask: "readonly",
        openProject: "readonly",
        openReview: "readonly",
        selectedTimeEntry: "writable",
        attendancePunchId: "writable",
        decisionId: "writable",
        attendancePunches: "readonly",
        azureRevision: "readonly",
        canonicalReviews: "readonly",
        decisions: "readonly",
        esc: "readonly",
        gapActions: "readonly",
        go: "readonly",
        people: "readonly",
        projects: "readonly",
        render: "readonly",
        revision: "readonly",
        sampleProjectAccess: "readonly",
        taskAccessible: "readonly",
        taskId: "writable",
        tasks: "readonly",
        timeEntries: "readonly"
      }
    }
  },
  {
    files: ["docs/ui/UX_GAP_DOCS_2026-10-08.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:fs$", "^node:path$"] }]
    }
  },
  {
    files: ["docs/ui/UX_GAP_WALKTHROUGH_2026-10-08.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        actor: "writable",
        render: "readonly",
        role: "writable",
        s18: "readonly",
        tasks: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:fs$", "^node:path$", "^node:assert/strict$", "^node:url$", "^@playwright/test$"] }]
    }
  },
  {
    files: ["docs/ui/UX_GAP_ASSEMBLE_2026-10-08.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: {
      "@typescript-eslint/no-require-imports": ["error", { allow: ["^node:fs$", "^node:path$"] }]
    }
  },
  {
    files: ["docs/ui/UX_CONTEXT_GAP_EXTENSION_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        actor: "readonly",
        azureRevision: "readonly",
        azureState: "readonly",
        contextName: "readonly",
        esc: "readonly",
        features: "readonly",
        go: "readonly",
        histories: "readonly",
        internal: "readonly",
        project: "writable",
        projects: "readonly",
        render: "readonly",
        reviewStatus: "readonly",
        revision: "readonly",
        s18: "writable",
        s27State: "writable",
        taskAccessible: "readonly",
        taskId: "readonly",
        tasks: "readonly",
        workflowActionGroups: "readonly"
      }
    }
  },
  {
    files: ["docs/ui/S18_UX_EXTENSION_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        $: "readonly",
        actor: "readonly",
        esc: "readonly",
        internal: "readonly",
        render: "readonly",
        role: "readonly"
      }
    }
  },
  {
    files: ["docs/ui/S27_UX_EXTENSION_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        actor: "readonly",
        esc: "readonly",
        histories: "readonly",
        internal: "readonly",
        openProject: "readonly",
        openTask: "readonly",
        owner: "readonly",
        people: "readonly",
        personalTask: "readonly",
        projects: "readonly",
        render: "readonly",
        role: "readonly",
        sampleProjectAccess: "readonly",
        taskAccessible: "readonly",
        tasks: "readonly"
      }
    }
  },
  {
    files: ["docs/ui/UX_MOBILE_WORKLISTS_2026-10-08.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        current: "readonly",
        taskFiltersOpen: "readonly"
      }
    },
    rules: { "@typescript-eslint/no-unused-vars": "off" }
  }
);

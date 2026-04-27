import { register } from "./tables";

register({
  name: "crm_ai_usage_log",

  title: "AI Usage Log",

  icon: "comment",

  query: {
    crm_ai_usage_log: [
      {
        id: null,
        time: null,
        account_id: null,
        analytics_cookie: null,
        input: null,
        output: null,
        system: null,
        total_tokens: null,
        prompt_tokens: null,
        total_time_s: null,
        project_id: null,
        path: null,
        history: null,
        model: null,
        tag: null,
      },
    ],
  },
  allowCreate: false,
  changes: false,
});

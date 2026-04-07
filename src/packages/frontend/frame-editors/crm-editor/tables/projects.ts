import { register } from "./tables";

register({
  name: "projects",

  title: "Projects",

  icon: "pencil",

  query: {
    crm_projects: [
      {
        title: null,
        theme: null,
        project_id: null,
        name: null,
        description: null,
        last_edited: null,
        created: null,
        users: null,
        deleted: null,
        notes: null,
      },
    ],
  },
});

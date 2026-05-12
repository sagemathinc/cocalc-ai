# Project Specific API

You can execute shell commands and code using a Jupyter kernel. Create an
instance of this API using cocalc_api.Project and pass in the project_id in
addition to the API key. The account API key must have an explicit project
capability for the selected project.

```py
>>> import cocalc_api
>>> project = cocalc_api.Project(api_key="sk-...", project_id='...')
```

::: cocalc_api.project.System

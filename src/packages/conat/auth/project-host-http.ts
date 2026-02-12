// Shared constants for project-host HTTP auth bootstrap.
// Browser app links include a short-lived bearer in query once, and project-host
// turns that into an HttpOnly cookie used by subsequent HTTP/WS requests.

export const PROJECT_HOST_HTTP_AUTH_QUERY_PARAM = "cocalc_project_host_token";
export const PROJECT_HOST_HTTP_AUTH_COOKIE_NAME =
  "cocalc_project_host_http_bearer";

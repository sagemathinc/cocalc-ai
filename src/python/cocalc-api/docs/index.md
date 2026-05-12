# CoCalc Python API Client

Install the Python client API `cocalc-api` that is [hosted on Pypi](https://pypi.org/project/cocalc-api/).

```sh
pip install cocalc-api
```

Obtain a [CoCalc account API Key](https://doc.cocalc.com/apikeys.html) by going to [your account preferences](https://cocalc.com/settings/account) and scrolling down to "Api Keys", then start using CoCalc from your Python scripts. Account API keys are scoped: they must have explicit capabilities, and project/file/exec capabilities require an allowed project list.

Depending on the capabilities granted to the key, the cocalc_api Python library can be used to do operations such as:

- [search](api/system/) for other cocalc users by name or email address, and get the name associated to an account_id
- list [your projects](api/projects), create projects, and inspect selected project metadata.
- run [shell commands](api/project) and Jupyter code in explicitly allowed projects.

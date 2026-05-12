How to setup a standalone nodejs command line session to connect to conat **as a project**

1. Create a file project-env.sh as explained in projects/conat/README.md, which defines these environment variables (your values will be different). You can use the command `export` from within a terminal in a project to find these values.

```sh
export CONAT_SERVER="http://localhost:5000/6b851643-360e-435e-b87e-f9a6ab64a8b1/port/5000"
export COCALC_PROJECT_ID="00847397-d6a8-4cb0-96a8-6ef64ac3e6cf"
export COCALC_USERNAME=`echo $COCALC_PROJECT_ID | tr -d '-'`
export HOME="/projects/6b851643-360e-435e-b87e-f9a6ab64a8b1/cocalc/src/data/projects/$COCALC_PROJECT_ID"
export DATA=$HOME/.smc

# optional for more flexibility, if the account API key has an explicit
# project capability and this project is in its allowed project list

export API_KEY=sk-OUwxAN8d0n7Ecd48000055

# optional for more logging

export DEBUG=cocalc:\*
export DEBUG_CONSOLE=yes
```

Account API keys are scoped. They only work here when the key has the required
project capability, such as `project:exec`, and the selected `COCALC_PROJECT_ID`
is in the key's allowed project list.

2. Then do this:

```sh
$ . project-env.sh
$ node
```

Now anything involving conat will work with identity the project.

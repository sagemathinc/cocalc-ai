# Project Startup Script

CoCalc projects may stop when idle, during host maintenance, or after a project
host restart. Each project has a startup script for lightweight setup that must
run again whenever the project starts.

The canonical script path is:

```sh
~/.local/share/cocalc/startup.sh
```

The project runtime creates this file with a commented template if it does not
already exist. Edit it from Project Settings -> Environment -> Startup Script,
or open the path directly in the project.

Output is written beside the script on each project start:

```sh
~/.local/share/cocalc/startup.log
~/.local/share/cocalc/startup.err
```

Keep the script fast. If it starts long-running services, run them in the
background and redirect their output, for example:

```sh
python -m http.server 8000 > ~/.local/share/cocalc/http.log 2>&1 &
```

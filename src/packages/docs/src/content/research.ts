/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RESEARCH_HANDOFF_BODY = String.raw`
Build a small analysis, check its saved output, and leave a collaborator enough
context to continue. This example uses Essential CoCalc, the focused interface
for one project or file at a time, and a Python notebook with no extra packages.

## Open your project in Essential

1. Open [Essential projects](/essential/projects) on this site. If prompted,
   choose **Open CoCalc to sign in**, sign in, then reopen the Essential link.
2. Use **Search projects** to find a project you can edit. To start separately,
   use **New project**, enter a **Project name**, and choose **Create project**.
   See [Create a project](/docs/projects/create-project) for choosing the project
   boundary and initial setup.
3. Open the project and choose **Files**. This example needs a project with
   storage and a Python 3 Jupyter kernel. If Essential reports **Project storage
   unavailable**, use the full interface to finish project placement first.
4. In **Home**, choose **New folder**, enter \`research-demo\`, and choose
   **Create folder**. Open that folder. Use a different name if it already exists.

The notebook and handoff note below belong in this folder. Substitute your
chosen folder name in the example paths.

## Create and check a small analysis

1. Choose **New file**, enter \`analysis.ipynb\`, and choose **Create file**.
   Essential creates an empty notebook and opens its read-only preview.
2. Copy the notebook's Essential URL, then use **File actions -> Full CoCalc**
   to open it in the full notebook editor. If the kernel chooser is not already
   open, choose **Kernel -> Change Kernel...**. Select an available Python 3
   kernel, such as **Python 3 (ipykernel)**; names depend on the project image.
   Choose **File -> Save**, then reopen the copied Essential URL and reload it.
   Essential does not select a kernel when it creates an empty notebook.
3. Choose **Edit or run notebook**, then **Add code cell**. Enter:

~~~python
values = [2, 4, 6, 8]
mean = sum(values) / len(values)
print(f"count={len(values)}")
print(f"mean={mean:.1f}")
~~~

4. Choose **Save notebook**, then the cell's **Run**. Check the output:

~~~text
count=4
mean=5.0
~~~

5. Check for **Execution finished and notebook outputs were saved.** Inspect
   the output itself as well: a finished execution can still contain an error.
6. Reload the page and confirm that the cell and its output remain. Copy the
   notebook's address-bar URL for the handoff.

Use the [Jupyter guide](/docs/jupyter/use-jupyter) for kernel setup and larger
notebooks. Essential's **Jupyter** navigation lists existing notebooks; create
this example through **Files**. HTML-only notebook output and interactive
widgets need the full interface; this example uses plain text output.

## Leave a handoff beside the notebook

Return to the folder using the file-path links. Create \`README.md\` with
**New file**, choose **Edit**, and adapt this note:

~~~markdown
# Research handoff

Question: What is the mean of the example measurements?
Inputs: The four values in analysis.ipynb: 2, 4, 6, 8.
Environment: Python 3; no additional packages.
Run: Open analysis.ipynb and run its code cell.
Checked result: count=4 and mean=5.0; saved output survives a page reload.
Next step: Replace the example inputs with agreed research data and rerun.
Notebook link: Paste the complete notebook URL here.
~~~

Choose **Save** and check **Saved.** and that **unsaved** disappears. Switching
to **Preview** alone is not a save check. Reload and confirm the note, then
copy its address-bar URL too. Record what you actually checked; for real work,
include the input location or revision, required software, and any unresolved
errors. Saved files preserve work, but do not by themselves demonstrate a
rerun in a newly created environment.

## Bring an agent into the same context

This step is optional. If you use Codex, first
[connect its credentials](/docs/ai/connect-credentials). Choose **Codex**, then
**New Codex chat**, review **Model**, **Reasoning**, and **Paid by**, and put a
bounded request in **Message Codex**, for example:

~~~text
Read /home/user/research-demo/analysis.ipynb and
/home/user/research-demo/README.md. Explain how the reported mean follows
from the inputs and suggest one additional check. Do not change files or run
commands. Identify anything you cannot verify from the saved contents.
~~~

Choose **Send** to start the task. Read the answer against the notebook before
adding conclusions to the handoff. Copy the current thread URL if a coauthor
needs that conversation, retaining its path and thread query parameters. Use
[Open Codex chat](/docs/ai/codex-chat) for the full interface's workflow.

## Give the recipient the right access

1. From Essential, choose **More**, **Settings**, then **Full project settings**.
   Open **People** in the full interface.
2. Follow [Add project collaborators](/docs/projects/collaborators). Choose
   **Collaborator** when the person must edit or rerun the analysis, or
   **Viewer** when they only need to read the saved results. For a viewer,
   include the notebook, handoff note, and any supporting files in their read
   policy; for this example, \`research-demo/\` selects the example folder.
3. For a collaborator, keep the Essential notebook and README links. For a
   viewer, open each file through **File actions -> Full CoCalc** and copy its
   full-interface URL instead. Use the full interface for viewer access.
4. After they accept, give them the appropriate links, project name, and next
   step. Share the Essential agent thread with coauthors who have collaborator
   access. Put any conclusions a viewer needs in the shared README.

Copying a project or file URL does not grant access. These links open current
project content; they are not frozen copies. Use
[Publish project files](/docs/projects/publish-files) when an unlisted file
share is the access model you want.

## Resume from another browser

Open the saved notebook and README links in a different browser or browser
profile, and sign in with an account that has the required project access.
Confirm the saved output and next step. A collaborator can rerun the cell and
compare its result; a viewer uses the full-interface links to inspect the
saved output.

**More -> Recent** lists files stored in the current browser's recent history.
An empty Recent list in another browser does not mean the project files were
lost: use **Files** or the copied links. If the project is unavailable to the
recipient, check their signed-in account and accepted invitation. If only a
file is unavailable, check the path and the viewer's read policy.

If a file changed while you were editing, resolve the reported conflict before
claiming the handoff is saved. Use the file's **File actions -> Full CoCalc**
link when you need the full editor, notebook output support, or conflict tools.
`;

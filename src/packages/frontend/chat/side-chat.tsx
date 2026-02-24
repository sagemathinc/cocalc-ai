import { CSS } from "@cocalc/frontend/app-framework";
import { redux, useEditorRedux } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "./actions";
import { ChatPanel } from "./chatroom";
import { ChatDocProvider, useChatDoc } from "./doc-context";
import type { ChatState } from "./store";
import { Loading } from "@cocalc/frontend/components";
import { isChatActions } from "./register";

interface Props {
  project_id: string;
  path: string;
  style?: CSS;
  fontSize?: number;
  actions?: ChatActions;
  desc?;
  hideSidebar?: boolean;
}

export default function SideChat({
  actions: actions0,
  project_id,
  path,
  style,
  fontSize,
  desc,
  hideSidebar = false,
}: Props) {
  const actionsViaContext = redux.getEditorActions(project_id, path);
  const candidateActions = actions0 ?? actionsViaContext;
  const actions: ChatActions | undefined = isChatActions(candidateActions)
    ? candidateActions
    : undefined;
  const useEditor = useEditorRedux<ChatState>({ project_id, path });
  // subscribe to syncdbReady to force re-render when sync attaches
  useEditor("syncdbReady");

  if (!actions) {
    return <Loading theme="medium" />;
  }

  return (
    <ChatDocProvider cache={actions.messageCache}>
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#efefef",
          ...style,
        }}
      >
        <SideChatInner
          actions={actions}
          project_id={project_id}
          path={path}
          fontSize={fontSize}
          desc={desc}
          hideSidebar={hideSidebar}
        />
      </div>
    </ChatDocProvider>
  );
}

function SideChatInner(props: Props & { actions: ChatActions }) {
  const { messages, threadIndex, version } = useChatDoc();
  return (
    <ChatPanel
      actions={props.actions}
      project_id={props.project_id}
      path={props.path}
      messages={messages}
      threadIndex={threadIndex}
      docVersion={version}
      fontSize={props.fontSize}
      desc={props.desc}
      variant="compact"
      hideSidebar={props.hideSidebar}
    />
  );
}

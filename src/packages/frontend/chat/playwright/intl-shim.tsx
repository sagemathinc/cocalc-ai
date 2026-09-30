import React from "react";

export function useIntl() {
  return {
    formatMessage: ({ defaultMessage }: { defaultMessage?: string }) =>
      defaultMessage ?? "",
  };
}

export function FormattedMessage(props: {
  defaultMessage?: string;
}): React.JSX.Element {
  return <>{props.defaultMessage ?? ""}</>;
}

export function defineMessage<T>(message: T): T {
  return message;
}

export function defineMessages<T>(messages: T): T {
  return messages;
}

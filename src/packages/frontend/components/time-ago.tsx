/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
 * Customized TimeAgo support
 * TODO: internationalize this formatter.
 */

import { Popover, Radio } from "antd";
import React, { CSSProperties as CSS, useEffect, useState } from "react";
import { is_date, is_different as misc_is_different } from "@cocalc/util/misc";
import useAppContext from "@cocalc/frontend/app/use-context";

function timeago_formatter(value, unit, suffix, _date) {
  if (value === 0) {
    return "now";
  }
  if (unit === "second") {
    return `less than a minute ${suffix}`;
  }
  if (value !== 1) {
    unit += "s";
  }
  return `${value} ${unit} ${suffix}`;
}

// This is just used for updates, so is_different if there
// is a *chance* they are different
export function is_different_date(
  date0: string | Date | number | undefined | null,
  date1: string | Date | number | undefined | null,
): boolean {
  const t0 = typeof date0;
  const t1 = typeof date1;
  if (t0 !== t1) {
    return true;
  }
  if (
    date0 == null ||
    date1 == null ||
    typeof date0 != "object" ||
    typeof date1 != "object"
  ) {
    return date0 !== date1;
  }
  return date0.valueOf() - date1.valueOf() != 0;
}

interface TimeAgoElementProps {
  placement?;
  tip?: string | React.JSX.Element; // optional body of the tip popover with title the original time.
  live?: boolean; // whether or not to auto-update
  date;
  time_ago_absolute?: boolean;
  style?: CSS;
  click_to_toggle?: boolean;
}

export const TimeAgoElement: React.FC<TimeAgoElementProps> = ({
  placement,
  tip,
  live,
  time_ago_absolute,
  date,
  style,
  click_to_toggle,
}) => {
  const isLive = live ?? true;

  if (placement == null) {
    placement = "top";
  }
  if (time_ago_absolute == null) {
    time_ago_absolute = false;
  }

  function render_timeago_element(d) {
    return (
      <span style={{ cursor: "pointer", ...style }}>
        <RelativeTimeText date={d} live={isLive} />
      </span>
    );
  }

  function iso(d) {
    try {
      return <div style={{ color: "#666" }}>{d.toISOString()}</div>;
    } catch (err) {
      return `${err}`;
    }
  }

  function render_timeago(d) {
    let s;
    try {
      s = d.toLocaleString();
    } catch (err) {
      s = `${err}`;
    }
    const el = render_timeago_element(d);
    if (!click_to_toggle) {
      return el;
    }
    return (
      <Popover
        trigger="click"
        title={s}
        content={() => (
          <>
            <div>{el}</div>
            {iso(d)}
            <ToggleRelativeAndAbsolute />
            {tip}
          </>
        )}
        placement={placement}
      >
        {el}
      </Popover>
    );
  }

  function render_absolute(d) {
    let s;
    try {
      s = d.toLocaleString();
    } catch (err) {
      s = `${err}`;
    }
    const el = (
      <span
        style={{ cursor: click_to_toggle ? "pointer" : undefined, ...style }}
      >
        {s}
      </span>
    );
    if (!click_to_toggle) {
      return el;
    }
    return (
      <Popover
        trigger="click"
        title={s}
        content={() => (
          <>
            {render_timeago_element(d)}
            {iso(d)}
            <ToggleRelativeAndAbsolute />
          </>
        )}
        placement={placement}
      >
        {el}
      </Popover>
    );
  }

  const d = is_date(date) ? (date as Date) : new Date(date);
  if (!d.valueOf()) {
    return null;
  }
  try {
    d.toISOString();
  } catch (error) {
    // NOTE: Using isNaN might not work on all browsers, so we use try/except
    // See https://github.com/sagemathinc/cocalc/issues/2069
    return <span>Invalid Date</span>;
  }

  if (time_ago_absolute) {
    return render_absolute(d);
  } else {
    return render_timeago(d);
  }
};

function relativeTimeParts(
  epochMs: number,
  nowMs: number,
): {
  refreshMs?: number;
  text: string;
} {
  const elapsedSeconds = Math.abs(nowMs - epochMs) / 1000;
  const seconds = Math.round(elapsedSeconds);
  const suffix = epochMs < nowMs ? "ago" : "from now";
  let unit = "year";
  let value = Math.round(seconds / (365 * 24 * 60 * 60));
  let refreshMs: number | undefined = msUntilDisplayChange(
    elapsedSeconds,
    (value + 0.5) * YEAR,
  );
  if (seconds < 60) {
    unit = "second";
    value = Math.round(seconds);
    refreshMs =
      value === 0
        ? 1000
        : (msUntilDisplayChange(elapsedSeconds, MINUTE) ?? 1000);
  } else if (seconds < 60 * 60) {
    unit = "minute";
    value = Math.round(seconds / 60);
    refreshMs = msUntilDisplayChange(
      elapsedSeconds,
      Math.min(HOUR, (value + 0.5) * MINUTE),
    );
  } else if (seconds < 24 * 60 * 60) {
    unit = "hour";
    value = Math.round(seconds / (60 * 60));
    refreshMs = msUntilDisplayChange(
      elapsedSeconds,
      Math.min(DAY, (value + 0.5) * HOUR),
    );
  } else if (seconds < 7 * 24 * 60 * 60) {
    unit = "day";
    value = Math.round(seconds / (24 * 60 * 60));
    refreshMs = msUntilDisplayChange(
      elapsedSeconds,
      Math.min(WEEK, (value + 0.5) * DAY),
    );
  } else if (seconds < 30 * 24 * 60 * 60) {
    unit = "week";
    value = Math.round(seconds / (7 * 24 * 60 * 60));
    refreshMs = msUntilDisplayChange(
      elapsedSeconds,
      Math.min(MONTH, (value + 0.5) * WEEK),
    );
  } else if (seconds < 365 * 24 * 60 * 60) {
    unit = "month";
    value = Math.round(seconds / (30 * 24 * 60 * 60));
    refreshMs = msUntilDisplayChange(
      elapsedSeconds,
      Math.min(YEAR, (value + 0.5) * MONTH),
    );
  }
  return {
    refreshMs,
    text: timeago_formatter(value, unit, suffix, epochMs),
  };
}

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const WEEK = DAY * 7;
const MONTH = DAY * 30;
const YEAR = DAY * 365;

function msUntilDisplayChange(
  elapsedSeconds: number,
  nextChangeSeconds: number,
): number | undefined {
  if (nextChangeSeconds <= elapsedSeconds) {
    return 1000;
  }
  return Math.max(1000, Math.ceil((nextChangeSeconds - elapsedSeconds) * 1000));
}

function RelativeTimeText({
  date,
  live,
}: {
  date: Date;
  live: boolean;
}): React.JSX.Element {
  const [, setTick] = useState(0);
  const epochMs = date.valueOf();
  const { refreshMs, text } = relativeTimeParts(epochMs, Date.now());

  useEffect(() => {
    if (!live || refreshMs == null) {
      return;
    }
    const timeoutId = setTimeout(() => {
      setTick((current) => current + 1);
    }, refreshMs);
    return () => clearTimeout(timeoutId);
  }, [epochMs, live, refreshMs]);

  return (
    <time dateTime={date.toISOString()} title="">
      {text}
    </time>
  );
}

interface TimeAgoProps {
  placement?;
  tip?: string | React.JSX.Element; // optional body of the tip popover with title the original time.
  live?: boolean; // whether or not to auto-update
  style?: CSS;
  date?;
  click_to_toggle?: boolean; // default true
  time_ago_absolute?: boolean;
}

export const TimeAgo: React.FC<TimeAgoProps> = React.memo(
  ({
    placement,
    tip,
    live,
    style,
    date,
    click_to_toggle = true,
    time_ago_absolute,
  }: TimeAgoElementProps) => {
    const { timeAgoAbsolute } = useAppContext();

    if (!date?.valueOf()) {
      return <></>;
    }

    return (
      <TimeAgoElement
        date={date}
        placement={placement}
        tip={tip}
        live={live}
        time_ago_absolute={time_ago_absolute ?? timeAgoAbsolute ?? false}
        style={style}
        click_to_toggle={click_to_toggle}
      />
    );
  },
  (props, next) => {
    // areEqual
    return !(
      is_different_date(props.date, next.date) ||
      misc_is_different(props, next, [
        "placement",
        "tip",
        "live",
        "click_to_toggle",
        "style",
        "time_ago_absolute",
      ])
    );
  },
);

function ToggleRelativeAndAbsolute({}) {
  const { timeAgoAbsolute, setTimeAgoAbsolute } = useAppContext();
  if (setTimeAgoAbsolute == null) {
    return null;
  }

  return (
    <div style={{ marginTop: "10px", textAlign: "center" }}>
      <Radio.Group
        onChange={() => {
          setTimeAgoAbsolute?.(!timeAgoAbsolute);
        }}
        value={timeAgoAbsolute ? "absolute" : "relative"}
        optionType="button"
        buttonStyle="solid"
        size="small"
      >
        <Radio value="relative">Relative</Radio>
        <Radio value="absolute">Absolute</Radio>
      </Radio.Group>
    </div>
  );
}

/*
I had to disable this for now since @cocalc/frontend/i18n doesn't support the nextjs app.

//import { labels } from "@cocalc/frontend/i18n";

 import { useIntl } from "react-intl";
const intl = useIntl();
        <Radio value="relative">{intl.formatMessage(labels.relative)}</Radio>
        <Radio value="absolute">{intl.formatMessage(labels.absolute)}</Radio>

*/

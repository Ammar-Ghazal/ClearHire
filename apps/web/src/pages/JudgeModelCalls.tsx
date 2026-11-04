import type { JudgeModelActivity, JudgeModelCall } from "@clearhire/shared";

const number = new Intl.NumberFormat();
const dollars = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

const amount = (value: number | null) =>
  value === null ? "—" : number.format(value);
const cost = (value: number | null) =>
  value === null ? "—" : dollars.format(value / 1_000_000);
const date = (value: string | null) =>
  value === null ? "—" : new Date(value).toLocaleString();

const statuses: Record<JudgeModelCall["settlement"], string> = {
  reserved: "In progress",
  settled: "Settled",
  released: "Reservation released",
  ambiguous: "Charge uncertain",
};

function CallDetails({
  call,
  activity,
}: {
  call: JudgeModelCall;
  activity?: JudgeModelActivity;
}) {
  const purpose =
    call.kind === "job" ? "Job posting analysis" : "Repository skill analysis";
  const target = call.jobTitle ?? call.repository;
  const status = call.errorCode
    ? "Failed"
    : call.settlement === "settled"
      ? "Completed"
      : activity?.receivedAt
        ? "Received · processing response"
        : activity?.sentAt
          ? "Sent · waiting for Meta"
          : statuses[call.settlement];
  const duration =
    call.latencyMs === null ? "—" : `${(call.latencyMs / 1000).toFixed(2)} s`;
  const details = [
    ...(activity
      ? [
          ["Queued", date(activity.queuedAt)],
          ["Sent", date(activity.sentAt)],
          ["Response received", date(activity.receivedAt)],
        ]
      : [["Started", date(call.createdAt)]]),
    ["Settled", date(call.settledAt)],
    ["Attempt", amount(call.attempt)],
    ["HTTP status", amount(call.httpStatus)],
    ["Finish reason", call.finishReason ?? "—"],
    ["Error code", call.errorCode ?? "—"],
    ["Input tokens", amount(call.promptTokens)],
    ["Cached input tokens", amount(call.cachedTokens)],
    ["Output tokens", amount(call.completionTokens)],
    ["Reasoning tokens", amount(call.reasoningTokens)],
    ["Request duration", duration],
    ["Reserved amount", cost(call.reservedMicroUsd)],
    ["Recorded cost", cost(call.costMicroUsd)],
    [
      "Cost basis",
      call.costSource === "usage"
        ? "Reported usage"
        : call.costSource === "reservation"
          ? "Estimated from reservation"
          : "—",
    ],
    ["Settlement", statuses[call.settlement]],
    ["Meta response ID", call.responseId ?? "—"],
  ];

  return (
    <details className="rounded-md border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer">
        <span className="font-medium">
          {purpose}
          {target && ` · ${target}`}
        </span>
        <span className="mt-1 block break-words text-slate-600">
          {call.model} · {status} · {duration} · {cost(call.costMicroUsd)}
        </span>
      </summary>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-3">
        {details.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-slate-500">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function JudgeModelCalls({
  calls,
  activity,
  running,
}: {
  calls: JudgeModelCall[];
  activity?: JudgeModelActivity[];
  running: boolean;
}) {
  return (
    <section
      className="mt-6 space-y-3 rounded-lg bg-slate-50 p-4 text-sm"
      aria-label="Meta model calls"
    >
      <h2 className="font-medium">Meta model calls</h2>
      <p className="text-slate-600">
        {activity
          ? "Requests from this analysis."
          : "Recent recorded analysis requests."}{" "}
        Expand a request to see its details.
      </p>
      {running && (
        <p role="status">
          {activity?.length
            ? "Analysis is running."
            : "Preparing GitHub evidence. Meta requests appear when queued."}
        </p>
      )}
      {activity?.length ? (
        <div className="space-y-2">
          {[...activity].reverse().map((entry) => {
            const call = calls.find(({ id }) => id === entry.callId);
            if (call)
              return (
                <CallDetails key={entry.id} call={call} activity={entry} />
              );
            const status = entry.failed
              ? "Failed before sending"
              : entry.receivedAt
                ? "Received · processing response"
                : entry.sentAt
                  ? "Sent · waiting for Meta"
                  : "Queued";
            return (
              <div
                key={entry.id}
                className="rounded-md border border-slate-200 bg-white p-3"
              >
                <p className="font-medium">
                  {entry.target} · Attempt {entry.attempt}
                </p>
                <p className="text-slate-600">
                  {entry.model} · {status}
                </p>
                <p className="text-slate-600">Queued {date(entry.queuedAt)}</p>
              </div>
            );
          })}
        </div>
      ) : calls.length ? (
        <div className="space-y-2">
          {calls.map((call) => (
            <CallDetails key={call.id} call={call} />
          ))}
        </div>
      ) : !running ? (
        <p>
          No Meta analysis requests were made. A saved sample posting or a
          repository with no attributable evidence can require no model call.
        </p>
      ) : null}
    </section>
  );
}

import type { Desk, Owner } from "../../lib/open-charts";
import { serviceTimeLabel } from "../clinic/OpenChartsCard";

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}

function ownerLabel(owner: Owner): string {
  return "unassigned" in owner ? "Unassigned" : owner.name;
}

export function openChartsDeskBadge(data?: Desk, error?: string): { count: number; tone: "alarm" | "plain"; title: string } {
  if (error || !data) return { count: 0, tone: "alarm", title: "Open charts" };
  const behind = (data.lastClinicDay?.count ?? 0) + data.older.count;
  const parts = [`${data.today.count} today`, ...(data.lastClinicDay ? [`${data.lastClinicDay.count} from ${dayLabel(data.lastClinicDay.date)}`] : []), `${data.older.count} older`];
  return { count: behind > 0 ? behind : data.today.count, tone: behind > 0 ? "alarm" : "plain", title: `Open charts: ${parts.join(" · ")}` };
}

export function OpenChartsDeskPanel({ data, error }: { data?: Desk; error?: string }) {
  return (
    <div className="odos-desk-open-charts" data-testid="open-charts-desk-panel">
      {error ? <p role="alert">{error}</p> : !data ? <p>Loading open charts…</p> : <>
        <section>
          <h3>Today</h3>
          {data.today.rows.length === 0 ? <p>No open charts today.</p> : <DeskRows rows={data.today.rows} timeZone={data.timeZone} />}
        </section>
        {data.lastClinicDay && <section>
          <h3>{`Last clinic day · ${dayLabel(data.lastClinicDay.date)}`}</h3>
          {data.lastClinicDay.rows.length === 0 ? <p>{`${dayLabel(data.lastClinicDay.date)} is clear ✓`}</p> : <DeskRows rows={data.lastClinicDay.rows} timeZone={data.timeZone} priorDay={data.lastClinicDay.date} />}
        </section>}
        {data.older.count > 0 && <section>
          <h3>Older</h3>
          {data.older.byOwner.map((entry) => <p className="odos-desk-open-older-owner" key={"unassigned" in entry.owner ? "unassigned" : entry.owner.reference}>{`${ownerLabel(entry.owner)} — ${entry.count} older · oldest ${dayLabel(entry.oldestServiceDate)}`}</p>)}
        </section>}
        {!data.complete && <p>Some counts may be incomplete.</p>}
      </>}
    </div>
  );
}

function DeskRows({ rows, timeZone, priorDay }: { rows: Desk["today"]["rows"]; timeZone: string; priorDay?: string }) {
  return <>{rows.map((row, index) => <p className="odos-desk-open-row" key={`${row.patient.reference}-${row.serviceStart}-${index}`}>
    <strong>{row.patient.name}</strong>
    <span>{`${ownerLabel(row.owner)} · ${serviceTimeLabel(row.serviceStart, timeZone)} · chart open`}</span>
    {priorDay && <span>{`from ${dayLabel(priorDay)}`}</span>}
  </p>)}</>;
}

import { useId } from "react";
import type { PhoneDraft, PatientDraftPhone } from "../../../../mcp/src/clinic/patient-telecom";
export function PhoneFields<T extends PhoneDraft>({ draft, errors, onChange, groupName }: { draft: T; errors: Record<string, string>; onChange: (draft: T) => void; groupName?: string }) {
  const id = useId();
  const setPhone = (index: number, change: Partial<PatientDraftPhone>) => onChange({
    ...draft,
    phones: draft.phones.map((phone, i) => i === index ? { ...phone, ...change } : phone) as PhoneDraft["phones"],
  });
  return <>
        {draft.phones.map((phone, index) => <div key={index} className="grid grid-cols-[1fr_8rem] items-start gap-3">
          <LabeledInput label={`Phone ${index + 1}`} type="tel" value={phone.value} error={errors[`phones.${index}.value`]} onChange={value => setPhone(index, { value })} />
          <label className="grid gap-1 text-sm font-medium text-[color:var(--odos-muted)]">Phone {index + 1} type
            <select className="scheduler-input" value={phone.use} onChange={event => setPhone(index, { use: event.target.value as PatientDraftPhone["use"] })}>
              {phone.use === "other" && <option value="other" disabled>Other</option>}
              <option value="mobile">Cell</option><option value="home">Home</option><option value="work">Work</option>
            </select>
          </label>
        </div>)}
        <fieldset className="grid gap-2 rounded border border-[var(--odos-line)] p-3">
          <legend className="px-1 text-sm font-semibold text-[color:var(--odos-text)]">Which number accepts text messages?</legend>
          {draft.phones.map((phone, index) => <label key={index} className="flex items-center gap-2 text-sm text-[color:var(--odos-text)]">
            <input type="radio" name={groupName ?? id} value={`phone${index + 1}`} checked={draft.textable === `phone${index + 1}`} onChange={() => onChange({ ...draft, textable: index === 0 ? "phone1" : "phone2" })} />
            Phone {index + 1}{phone.value.trim() ? ` · ${phone.value}` : ""}
          </label>)}
          <label className="flex items-center gap-2 text-sm text-[color:var(--odos-text)]">
            <input type="radio" name={groupName ?? id} value="neither" checked={draft.textable === "neither"} onChange={() => onChange({ ...draft, textable: "neither" })} />
            Neither — none of my numbers can receive texts
          </label>
          <p className="text-xs leading-relaxed text-[color:var(--odos-muted)]">To stop or change the messages we send you, use the contact-preferences section — this question is only about which of your numbers can receive a text.</p>
        </fieldset>
  </>;
}

export function LabeledInput({ label, type, value, error, onChange }: { label: string; type: string; value: string; error?: string; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm font-medium text-[color:var(--odos-muted)]">{label}<input className="scheduler-input" type={type} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error && <span className="text-sm text-red-200">{error}</span>}</label>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { PracticeRoleId } from "../../lib/practice-roles";

type SettingsLink = {
  href: string;
  title: string;
  description: string;
  synonyms: readonly string[];
  practiceAdminOnly?: boolean;
};

type SettingsGroup = {
  title: string;
  description: string;
  tone: "sapphire" | "amethyst" | "emerald" | "gold" | "amber" | "rose" | "slate";
  links: readonly SettingsLink[];
};

const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    title: "People & Access",
    description: "Who can enter the practice system and what they can do.",
    tone: "sapphire",
    links: [
      {
        href: "/settings/staff",
        title: "Staff",
        description: "Invite staff and assign practice roles.",
        synonyms: ["people", "team", "users", "roles", "permissions", "access"],
        practiceAdminOnly: true,
      },
    ],
  },
  {
    title: "Clinical",
    description: "Shape the charting language clinicians use every day.",
    tone: "amethyst",
    links: [
      {
        href: "/settings/chart-fields-sections",
        title: "Chart fields and sections",
        description: "Manage practice-created chart fields and section placement.",
        synonyms: ["exam", "charting", "custom fields", "sections", "documentation"],
      },
      {
        href: "/settings/suggested-diagnoses",
        title: "Suggested diagnoses",
        description: "Manage the diagnosis catalog and finding-to-diagnosis suggestion mappings.",
        synonyms: ["diagnosis", "diagnoses", "icd", "findings", "mapping", "suggestions"],
      },
      {
        href: "/settings/treatment-protocols",
        title: "Treatment protocols",
        description: "Define multi-session procedures, interval windows, and maintenance follow-up.",
        synonyms: ["series", "sessions", "dry eye", "ipl", "rf", "care plan", "protocol"],
        practiceAdminOnly: true,
      },
    ],
  },
  {
    title: "Schedule",
    description: "Define the appointment vocabulary used by the desk.",
    tone: "emerald",
    links: [
      {
        href: "/settings/visit-types",
        title: "Visit types",
        description: "Manage scheduling categories, labels, colors, durations, and availability.",
        synonyms: ["appointments", "calendar", "duration", "availability", "categories"],
      },
    ],
  },
  {
    title: "Financial",
    description: "Keep benefit assumptions and optical prices consistent.",
    tone: "gold",
    links: [
      {
        href: "/settings/vision-plan-templates",
        title: "Vision plan templates",
        description: "Manage reusable plan-level values for manual vision benefit entry.",
        synonyms: ["insurance", "benefits", "payer", "copay", "allowance", "plans"],
      },
      {
        href: "/settings/optical-pricing",
        title: "Optical pricing",
        description: "Manage frame and contact lens wholesale and retail prices.",
        synonyms: ["prices", "retail", "wholesale", "contact lens", "frames", "cost"],
      },
      {
        href: "/settings/lens-catalog",
        title: "Lens Catalog",
        description: "Manage per-lab lens products, coatings, modifiers, and shared vocabularies.",
        synonyms: ["lens", "lenses", "lab", "matrix", "coating", "modifier", "wholesale", "margin"],
        practiceAdminOnly: true,
      },
      {
        href: "/settings/plan-profiles",
        title: "Plan profiles",
        description: "Seed expected plan reimbursement for margin estimates.",
        synonyms: ["insurance", "payer", "reimbursement", "margin", "estimate", "allowance"],
        practiceAdminOnly: true,
      },
      {
        href: "/settings/packages",
        title: "Packages",
        description: "Define prepaid procedure series, expiry, and refund policy.",
        synonyms: ["prepaid", "sessions", "dry eye", "ipl", "rf", "series"],
        practiceAdminOnly: true,
      },
      {
        href: "/settings/statement-messages",
        title: "Statement and receipt messages",
        description: "Set the practice-wide footer notes printed on statements and receipts.",
        synonyms: ["footer", "message", "receipt", "statement", "collections", "portal"],
        practiceAdminOnly: true,
      },
    ],
  },
  {
    title: "Inventory",
    description: "Control the sources that feed the practice catalog.",
    tone: "amber",
    links: [
      {
        href: "/admin/practice/settings/frames-data",
        title: "Frames data",
        description: "Manage frame catalog and inventory data sources.",
        synonyms: ["inventory", "catalog", "stock", "vendor", "frames data"],
      },
    ],
  },
  {
    title: "Communications",
    description: "Shared communication controls will live here as they ship.",
    tone: "rose",
    links: [],
  },
  {
    title: "Practice",
    description: "Tune the operational floor to match how this practice works.",
    tone: "slate",
    links: [
      {
        href: "/settings/floor-config",
        title: "Floor config",
        description: "Manage floor stations, lane thresholds, and payer cues.",
        synonyms: ["stations", "rooms", "lanes", "thresholds", "flow", "payer cues"],
      },
    ],
  },
];

export function SettingsIndex({ roles = [] }: { roles?: readonly PracticeRoleId[] }) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterSettingsGroups(SETTINGS_GROUPS, roles, query), [query, roles]);
  const resultCount = groups.reduce((total, group) => total + group.links.length, 0);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const focusSearch = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase();
      const commandSearch = (event.metaKey || event.ctrlKey) && key === "k";
      const slashSearch = !event.metaKey && !event.ctrlKey && !event.altKey && key === "/";
      if ((!commandSearch && !slashSearch) || isEditableTarget(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <main className="practice-settings">
      <div className="odos-ambient" />
      <div className="practice-settings-body">
        <header className="practice-settings-hero">
          <div>
            <div className="practice-settings-kicker">Practice Admin</div>
            <h1>Practice</h1>
            <p>Find and manage the settings that shape your staff, clinic, desk, and dispensary.</p>
          </div>
          <label className="practice-settings-search">
            <span className="sr-only">Find a setting</span>
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Find a setting"
              aria-keyshortcuts="Meta+K Control+K /"
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>⌘K</kbd>
          </label>
        </header>

        {query.trim() && (
          <div className="practice-settings-results" role="status">
            {resultCount} {resultCount === 1 ? "setting" : "settings"} found
          </div>
        )}

        {groups.length > 0 ? (
          <div className="practice-settings-grid" aria-label="Settings sections">
            {groups.map((group) => (
              <section
                key={group.title}
                className={`practice-settings-group practice-settings-tone-${group.tone}`}
              >
                <div className="practice-settings-edge" />
                <header>
                  <h2>{group.title}</h2>
                  <p>{group.description}</p>
                </header>
                {group.links.length > 0 ? (
                  <ul>
                    {group.links.map((link) => (
                      <li key={link.href}>
                        <a href={link.href}>
                          <span>
                            <strong>{link.title}</strong>
                            <small>{link.description}</small>
                          </span>
                          <span className="practice-settings-manage">Manage <span aria-hidden="true">→</span></span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="practice-settings-empty">No settings in this group yet.</div>
                )}
              </section>
            ))}
          </div>
        ) : (
          <div className="practice-settings-no-results">
            <strong>No settings found</strong>
            <span>Try a section name, task, or familiar office term.</span>
          </div>
        )}
      </div>
    </main>
  );
}

function filterSettingsGroups(
  groups: readonly SettingsGroup[],
  roles: readonly PracticeRoleId[],
  query: string,
): SettingsGroup[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return groups
    .map((group) => {
      const permitted = group.links.filter((link) => !link.practiceAdminOnly || roles.includes("practice-admin"));
      if (terms.length === 0) return { ...group, links: permitted };
      const links = permitted.filter((link) => {
        const haystack = [
          group.title,
          group.description,
          link.title,
          link.description,
          ...link.synonyms,
        ].join(" ").toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      return { ...group, links };
    })
    .filter((group) => query.trim().length === 0 || group.links.length > 0);
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(
    element?.isContentEditable
    || element?.tagName === "INPUT"
    || element?.tagName === "TEXTAREA"
    || element?.tagName === "SELECT",
  );
}

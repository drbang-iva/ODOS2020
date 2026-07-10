const SETTINGS_LINKS = [
  {
    href: "/settings/visit-types",
    title: "Visit types",
    description: "Manage scheduling categories, labels, colors, durations, and availability.",
  },
  {
    href: "/settings/floor-config",
    title: "Floor config",
    description: "Manage floor stations, lane thresholds, and payer cues.",
  },
  {
    href: "/settings/vision-plan-templates",
    title: "Vision plan templates",
    description: "Manage reusable plan-level values for manual vision benefit entry.",
  },
  {
    href: "/settings/chart-fields-sections",
    title: "Chart fields and sections",
    description: "Manage practice-created chart fields and section placement.",
  },
  {
    href: "/admin/practice/settings/frames-data",
    title: "Frames data",
    description: "Manage frame catalog and inventory data sources.",
  },
] as const;

export function SettingsIndex() {
  return (
    <main className="min-h-screen bg-[#060610] p-6 text-white">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <div className="text-xs uppercase tracking-wide text-white/45">Practice Admin</div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-2 text-sm text-white/55">
            Choose a settings section. Additional shared catalog sections appear here as they ship.
          </p>
        </header>
        <ul aria-label="Settings sections" className="grid gap-2">
          {SETTINGS_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="block border border-white/10 bg-white/[0.035] px-4 py-3 hover:border-white/25 hover:bg-white/[0.06]"
              >
                <span className="block text-sm font-semibold text-white/90">{link.title}</span>
                <span className="mt-1 block text-xs text-white/45">{link.description}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

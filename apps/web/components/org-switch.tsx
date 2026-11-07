"use client";
import { useRouter } from "next/navigation";

export function OrgSwitch({ current, orgs }: { current: string; orgs: { id: string; name: string }[] }) {
  const router = useRouter();
  if (orgs.length < 2) return null;
  return (
    <div className="org-switch">
      <label htmlFor="org-select">Organização</label>
      <select id="org-select" value={current} onChange={(e) => router.push(`/o/${e.target.value}`)}>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}

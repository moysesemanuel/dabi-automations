import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { apiGet } from "./api";
import type { Membership, Role } from "./types";

const memberships = cache(() => apiGet<Membership[]>("/me"));

/** Papel da pessoa nesta organização (para esconder botões; a API é quem autoriza de verdade). */
export async function roleIn(orgId: string): Promise<Role> {
  const m = (await memberships()).find((x) => x.organization.id === orgId);
  if (!m) notFound();
  return m.role;
}

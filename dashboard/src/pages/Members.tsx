import { useCallback, useEffect, useState } from "react";
import { Banner, CodeBlock, StatusPill } from "../components";
import { apiJson, errorText, formatDate, type Api, type AuthUser, type Role } from "../lib/api";

// Members page (admin only, DESIGN §7.6 / §8.1). The API enforces every rule shown here (last
// admin can't be demoted, members get 403); the UI only explains them.

type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled_at: string | null;
  created_at: string;
  active_keys: number;
};

type Invite = {
  id: string;
  email: string;
  role: Role;
  invited_by_email: string;
  expires_at: string;
  created_at: string;
};

export function MembersPage({ api, user }: { api: Api; user: AuthUser }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        apiJson<{ members: Member[] }>(api, "/api/members"),
        apiJson<{ invites: Invite[] }>(api, "/api/invites"),
      ]);
      setMembers(m.members);
      setInvites(i.invites);
    } catch (err) {
      setError(errorText(err, "Members could not be loaded."));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, action: () => Promise<string>) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setError(errorText(err, "The request failed."));
    } finally {
      setBusy(null);
    }
  }

  const changeRole = (m: Member, role: Role) =>
    run(m.id, async () => {
      await apiJson(api, `/api/members/${m.id}`, { method: "PATCH", json: { role } });
      return `${m.email} is now ${role}.`;
    });

  const toggleDisabled = (m: Member) => {
    const disable = !m.disabled_at;
    if (disable && !window.confirm(`Disable ${m.email}? They are logged out and all their API keys stop working on the next request.`)) return;
    void run(m.id, async () => {
      await apiJson(api, `/api/members/${m.id}`, { method: "PATCH", json: { disabled: disable } });
      return disable ? `${m.email} disabled.` : `${m.email} enabled again (revoked keys stay revoked).`;
    });
  };

  const createInvite = () =>
    run("invite", async () => {
      const r = await apiJson<{ invite: { email: string }; url: string }>(api, "/api/invites", {
        method: "POST",
        json: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteLink({ email: r.invite.email, url: r.url });
      setInviteEmail("");
      return `Invite created for ${r.invite.email}.`;
    });

  const revokeInvite = (i: Invite) =>
    run(i.id, async () => {
      await apiJson(api, `/api/invites/${i.id}`, { method: "DELETE" });
      return `Invite for ${i.email} revoked.`;
    });

  return (
    <section className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Team</p>
          <h2>Members</h2>
          <p className="subtle">Admins manage servers, members and everyone's keys. Members use tools and manage their own keys.</p>
        </div>
      </header>

      <Banner
        error={error}
        notice={notice}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />

      <article className="card formCard">
        <h3>Invite someone</h3>
        <div className="inlineRow">
          <label className="field grow">
            <span>Email</span>
            <input type="email" value={inviteEmail} placeholder="teammate@example.com" onChange={(e) => setInviteEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Role</span>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="btn btnPrimary" disabled={!inviteEmail.trim() || busy === "invite"} onClick={() => void createInvite()}>
            Create invite link
          </button>
        </div>
        {inviteLink && (
          <div className="onceBox">
            <p>
              <strong>Send this link to {inviteLink.email}.</strong> It is shown only now, works once, and expires in 7 days.
            </p>
            <CodeBlock code={inviteLink.url} />
            <button className="inlineLink" onClick={() => setInviteLink(null)}>
              Done
            </button>
          </div>
        )}
        {invites.length > 0 && (
          <table className="dataTable">
            <thead>
              <tr>
                <th>Pending invite</th>
                <th>Role</th>
                <th>Invited by</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{i.role}</td>
                  <td>{i.invited_by_email}</td>
                  <td>{formatDate(i.expires_at)}</td>
                  <td>
                    <button className="btn btnDanger btnSmall" disabled={busy === i.id} onClick={() => void revokeInvite(i)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      <article className="card">
        <table className="dataTable">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
              <th>Active keys</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={m.disabled_at ? "rowMuted" : undefined}>
                <td>
                  <strong>{m.name}</strong>
                  {m.id === user.id && <span className="subtle"> (you)</span>}
                  <div className="subtle">{m.email}</div>
                </td>
                <td>
                  <select value={m.role} disabled={busy === m.id} onChange={(e) => void changeRole(m, e.target.value as Role)}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>
                  <StatusPill value={m.disabled_at ? "disabled" : "active"} />
                </td>
                <td>{m.active_keys}</td>
                <td>{formatDate(m.created_at)}</td>
                <td>
                  <button className={`btn btnSmall ${m.disabled_at ? "btnSecondary" : "btnDanger"}`} disabled={busy === m.id} onClick={() => toggleDisabled(m)}>
                    {m.disabled_at ? "Enable" : "Disable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </section>
  );
}

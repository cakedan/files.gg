import { Link } from 'react-router';

import { formatBytes } from '../../../lib/format';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { RULE_TEXT, WARNING_TEXT } from '../../safety/labels';
import type { AdminAlbumDetail, AdminDomainDetail, AdminFileDetail, AdminUserDetail } from '../adminApi';
import { flagLabel } from '../format';
import { albumActions, canOpenMedia, domainActions, fileActions, userActions } from '../permissions';
import { useStaff } from '../staffContext';
import { ActionPanel } from './ActionPanel';
import { BanForm } from './BanForm';
import { Section, TargetState, When } from './bits';
import { StaffMedia } from './StaffMedia';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function OwnerFact({ owner }: { owner: AdminFileDetail['owner'] }) {
  if (owner.anonymous) return <>Anonymous{owner.guest_id ? ` (guest ${owner.guest_id})` : ''}</>;
  return owner.user_id ? (
    <Link to={`/admin/users/${owner.user_id}`} className="text-gg hover:underline">
      {owner.username ?? owner.user_id}
    </Link>
  ) : (
    <>Unknown</>
  );
}

const moderationOf = (detail: AdminFileDetail): 'visible' | 'hidden' | 'removed' =>
  detail.moderation_state ?? (detail.file.safety?.state === 'hidden' ? 'hidden' : detail.file.safety?.state === 'removed' ? 'removed' : 'visible');

/** A file target: the staff preview, facts, scanner findings, actions and bans. */
/** `info` (preview and facts), `actions` (action panel and bans) or both. */
type Part = 'info' | 'actions' | 'all';

export function FileTarget({ detail, caseId, childSafety, part = 'all' }: { detail: AdminFileDetail; caseId?: string; childSafety: boolean; part?: Part }) {
  const staff = useStaff();
  const now = useNow(RELATIVE_REFRESH_MS);
  const { file } = detail;
  const hashMatched = Boolean(detail.hash_matched);
  const csamRelated = hashMatched || detail.moderation_rule === 'csam' || file.safety?.reason === 'FILE_BLOCKED';
  const options = fileActions(staff, {
    moderationState: moderationOf(detail),
    scanState: detail.scan_state,
    scanStuck: Boolean(detail.scan_stuck),
    nsfw: Boolean(file.nsfw),
    hashMatched,
    csamRelated,
  });
  const allowed = canOpenMedia(staff, { childSafety, hashMatched });

  return (
    <>
      {part !== 'actions' && (
        <>
          <Section title="Target">
            <StaffMedia
              kind={file.kind}
              label={file.filename}
              urls={allowed ? detail.staff_urls : undefined}
              hashMatched={hashMatched}
              unavailableReason={childSafety && !staff.child_safety ? 'Only child-safety staff can open this media.' : undefined}
            />
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Fact label="Name">{hashMatched && !staff.child_safety ? 'Hidden' : file.filename}</Fact>
              <Fact label="State">
                <TargetState state={detail.deleted ? 'deleted' : (file.safety?.state ?? 'ok')} />
              </Fact>
              <Fact label="Owner">
                <OwnerFact owner={detail.owner} />
              </Fact>
              <Fact label="Size">{formatBytes(file.size)}</Fact>
              <Fact label="Type">{file.mimetype}</Fact>
              <Fact label="Uploaded">
                <When at={file.uploaded_at} now={now} />
              </Fact>
              <Fact label="Access">{file.visibility === 'link' ? 'Anyone with the link' : file.visibility === 'password' ? 'Password' : 'Only the owner'}</Fact>
              <Fact label="Scan">{detail.scan_state}</Fact>
              <Fact label="NSFW">
                {file.nsfw ? `Yes${file.safety?.nsfw_source ? ` (${file.safety.nsfw_source})` : ''}` : 'No'}
                {detail.nsfw_score !== null && ` · score ${detail.nsfw_score.toFixed(2)}`}
              </Fact>
              {detail.moderation_rule && <Fact label="Rule">{RULE_TEXT[detail.moderation_rule] ?? detail.moderation_rule}</Fact>}
              <Fact label="Same content">{detail.same_hash.count === 1 ? 'Only this file' : `${detail.same_hash.count} files`}</Fact>
              {detail.albums.length > 0 && (
                <Fact label="Albums">
                  {detail.albums.map((album, index) => (
                    <span key={album.id}>
                      {index > 0 && ', '}
                      <Link to={`/admin/albums/${album.id}`} className="text-gg hover:underline">
                        {album.title || album.vanity}
                      </Link>
                    </span>
                  ))}
                </Fact>
              )}
            </dl>
          </Section>

          <Section title="Scanner findings">
            {detail.scan.findings.length === 0 && !(detail.scan.warnings ?? []).length ? (
              <p className="text-sm text-muted">{hashMatched ? 'Matched a CSAM hash list. The details are in the case and the evidence record.' : 'Nothing found.'}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {detail.scan.findings.map((finding) => (
                  <li key={`${finding.check}-${finding.code}`}>
                    <span className="font-medium">{flagLabel(finding.code)}</span> <span className="text-muted">({finding.check}: {finding.detail})</span>
                  </li>
                ))}
                {(detail.scan.warnings ?? []).map((warning) => (
                  <li key={warning} className="text-muted">
                    Warning shown to visitors: {WARNING_TEXT[warning] ?? warning}
                  </li>
                ))}
              </ul>
            )}
            {(detail.scan.link_warnings ?? []).length > 0 && (
              <ul className="flex flex-col gap-0.5 text-xs text-muted">
                {detail.scan.link_warnings!.map((url) => (
                  <li key={url} className="break-all">
                    Flagged link: {url}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {part !== 'info' && !detail.deleted && (
        <ActionPanel
          target={{ type: hashMatched ? 'hash' : 'file', id: file.id }}
          options={options}
          caseId={caseId}
          emptyText={hashMatched ? 'Hash-matched content can’t be unblocked or shown. Record the CyberTipline report in the case.' : undefined}
        />
      )}
      {part !== 'info' && !hashMatched && <BanForm from={{ file_id: file.id }} anonymous={detail.owner.anonymous} />}
    </>
  );
}

/** An album target: every item's staff preview (blurred), facts and actions. */
export function AlbumTarget({ detail, caseId, childSafety, part = 'all' }: { detail: AdminAlbumDetail; caseId?: string; childSafety: boolean; part?: Part }) {
  const staff = useStaff();
  const { album } = detail;
  const allowed = canOpenMedia(staff, { childSafety, hashMatched: false });
  return (
    <>
      {part !== 'actions' && (
        <Section title="Target">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Fact label="Title">{album.title || 'Untitled album'}</Fact>
            <Fact label="State">
              <TargetState state={detail.deleted ? 'deleted' : detail.moderation_state === 'visible' ? 'ok' : detail.moderation_state} />
            </Fact>
            <Fact label="Owner">
              <OwnerFact owner={detail.owner} />
            </Fact>
            <Fact label="Items">{album.items.length}</Fact>
            <Fact label="Sensitive">{detail.nsfw_marked ? `Marked (${detail.nsfw_source ?? 'owner'})` : album.nsfw ? 'From its items' : 'No'}</Fact>
            <Fact label="Link">{album.url.replace(/^https?:\/\//, '')}</Fact>
          </dl>
          {album.description && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted">Description</span>
              <p className="text-sm break-words whitespace-pre-wrap">{album.description}</p>
            </div>
          )}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {album.items.map((item) => (
              <li key={item.id} className="flex flex-col gap-1">
                <StaffMedia kind={item.kind} label={item.filename} urls={allowed ? item.staff_urls : undefined} size="sm" unavailableReason={allowed ? undefined : 'Only child-safety staff can open this media.'} />
                <Link to={`/admin/files/${item.id}`} className="truncate text-xs text-gg hover:underline">
                  {item.filename}
                </Link>
                {item.caption && <p className="text-xs break-words text-muted">{item.caption}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {part !== 'info' && !detail.deleted && (
        <ActionPanel target={{ type: 'album', id: album.id }} options={albumActions(staff, { moderationState: detail.moderation_state, nsfwMarked: detail.nsfw_marked })} caseId={caseId} />
      )}
    </>
  );
}

/** An account target: facts, restrictions, strikes, recent files and the account actions. */
export function UserTarget({ detail, caseId, part = 'all' }: { detail: AdminUserDetail; caseId?: string; part?: Part }) {
  const staff = useStaff();
  const now = useNow(RELATIVE_REFRESH_MS);
  const active = detail.restrictions.filter((r) => r.lifted_at === null && (r.ends_at === null || r.ends_at * 1000 > now));
  const suspension = active.find((r) => r.kind === 'suspended');
  const options = userActions(staff, {
    restricted: active.some((r) => r.kind === 'uploads'),
    suspended: Boolean(suspension),
    csamSuspension: suspension?.rule === 'csam',
  });
  return (
    <>
      {part !== 'actions' && (
        <Section title="Account">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Fact label="Username">{detail.user.username}</Fact>
            <Fact label="Email">{detail.user.email ?? 'None'}</Fact>
            <Fact label="Created">
              <When at={detail.user.created_at} now={now} />
            </Fact>
            <Fact label="Staff">{detail.staff ? `${detail.staff.role}${detail.staff.child_safety ? ', child safety' : ''}` : 'No'}</Fact>
            <Fact label="Notices">
              {detail.warnings.count}
              {detail.warnings.strikes !== undefined && ` (${detail.warnings.strikes} ${detail.warnings.strikes === 1 ? 'strike' : 'strikes'} in 90 days)`}
            </Fact>
            <Fact label="Files and albums">
              {detail.counts.files} files, {detail.counts.albums} albums
            </Fact>
            <Fact label="Reports">
              {detail.counts.reports_made} made, {detail.counts.reports_against} against
            </Fact>
          </dl>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Restrictions</span>
            {detail.restrictions.length === 0 ? (
              <p className="text-sm">None</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {detail.restrictions.map((r) => (
                  <li key={r.id}>
                    {r.kind === 'uploads' ? 'Uploads restricted' : 'Suspended'} · {RULE_TEXT[r.rule] ?? r.rule}
                    <span className="text-muted">
                      {r.lifted_at !== null ? ' · lifted' : r.ends_at === null ? ' · until lifted' : r.ends_at * 1000 <= now ? ' · ended' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {detail.files.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">Newest files</span>
              <ul className="flex flex-col gap-0.5 text-sm">
                {detail.files.slice(0, 10).map((file) => (
                  <li key={file.id} className="flex items-center gap-2">
                    <Link to={`/admin/files/${file.id}`} className="min-w-0 truncate text-gg hover:underline">
                      {file.filename}
                    </Link>
                    <TargetState state={file.safety?.state ?? 'ok'} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}
      {part !== 'info' && <ActionPanel target={{ type: 'user', id: detail.user.id }} options={options} caseId={caseId} />}
    </>
  );
}

const DOMAIN_STATUS: Record<string, string> = {
  pending_dns: 'Waiting for DNS',
  pending_cert: 'Issuing certificate',
  active: 'Active',
  failing: 'Failing',
  failed: 'Failed',
  paused: 'Paused (premium ended)',
  disabled: 'Disabled by staff',
};

/** A custom domain target (milestone-6 §10.12): facts, and disable, enable or force “Only my files”. */
export function DomainTarget({ detail, caseId, part = 'all' }: { detail: AdminDomainDetail; caseId?: string; part?: Part }) {
  const staff = useStaff();
  const now = useNow(RELATIVE_REFRESH_MS);
  return (
    <>
      {part !== 'actions' && (
        <Section title="Domain">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Fact label="Hostname">
              <span className="font-mono">{detail.hostname}</span>
            </Fact>
            <Fact label="Status">
              {DOMAIN_STATUS[detail.status] ?? detail.status}
              {detail.status_reason && <span className="text-muted"> · {detail.status_reason}</span>}
            </Fact>
            <Fact label="Serving">{detail.serving ? 'Yes' : 'No'}</Fact>
            <Fact label="Owner">
              {detail.owner ? (
                <Link to={`/admin/users/${detail.owner.id}`} className="text-gg hover:underline">
                  {detail.owner.username}
                </Link>
              ) : (
                'Unknown'
              )}
            </Fact>
            <Fact label="Shows">{detail.scope === 'own' ? 'Only the owner’s files' : 'Anyone’s files'}</Fact>
            <Fact label="Added">
              <When at={detail.created_at} now={now} />
            </Fact>
            {detail.disabled_reason && <Fact label="Disabled for">{RULE_TEXT[detail.disabled_reason] ?? detail.disabled_reason}</Fact>}
            {detail.cf_hostname_id && <Fact label="Cloudflare id">{detail.cf_hostname_id}</Fact>}
          </dl>
        </Section>
      )}
      {part !== 'info' && <ActionPanel target={{ type: 'domain', id: detail.id }} options={domainActions(staff, detail)} caseId={caseId} />}
    </>
  );
}

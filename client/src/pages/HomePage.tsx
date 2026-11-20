import { useCallback, useEffect, useState } from 'react';
import { Alert, ConfirmDialog, Dialog, Spinner, StatusChip } from '../components/ui';
import { useAppConfig } from '../hooks/useAppConfig';
import { api, describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes, languageName, timeAgo } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { formatClock } from '../shared';
import type { Project } from '../types';

function ProjectCard({ project, languages, onRename, onDelete }: { project: Project; languages: { code: string; name: string }[]; onRename: () => void; onDelete: () => void }) {
  const { navigate } = useRouter();
  const media = project.media;
  const [posterFailed, setPosterFailed] = useState(false);
  const target = project.targetLanguage !== 'none' ? ` → ${languageName(languages, project.targetLanguage)}` : '';
  // Unfinished projects (no video yet) go back to the wizard's data via the editor, which explains what is missing.
  const open = () => navigate(`/editor/${project.id}`);
  return (
    <article className="card project-card" data-testid="project-card">
      <button type="button" className="project-thumb" onClick={open} aria-label={`Open ${project.name || 'Untitled project'}`}>
        {media && !posterFailed ? (
          <img src={api.assetUrl(project.id, 'poster', project.updatedAt.slice(0, 10) + media.duration)} alt="" loading="lazy" onError={() => setPosterFailed(true)} />
        ) : (
          <span className="thumb-placeholder" aria-hidden="true">▶</span>
        )}
        {media && <span className="thumb-duration">{formatClock(media.duration)}</span>}
      </button>
      <div className="project-body">
        <div className="row between gap">
          <h3 className="project-name" title={project.name}>{project.name || 'Untitled project'}</h3>
          <StatusChip status={project.status} />
        </div>
        <p className="muted small">
          {project.subtitleCount > 0 ? `${project.subtitleCount} subtitles` : 'No subtitles yet'}
          {media ? ` · ${formatBytes(media.size)}` : ''}
          {target ? ` · ${languageName(languages, project.sourceLanguage)}${target}` : ''}
        </p>
        <p className="muted small">Edited {timeAgo(project.updatedAt)}</p>
        <div className="row gap wrap">
          <button type="button" className="btn btn-sm btn-primary" onClick={open}>Open</button>
          <Link to={`/export/${project.id}`} className="btn btn-sm">Export</Link>
          <button type="button" className="btn btn-sm" onClick={onRename}>Rename</button>
          <button type="button" className="btn btn-sm btn-ghost-danger" onClick={onDelete}>Delete</button>
        </div>
      </div>
    </article>
  );
}

export function HomePage() {
  const { config } = useAppConfig();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ project: Project; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects((await api.listProjects()).projects);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function doRename() {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.saveProject(renaming.project.id, { name });
      setRenaming(null);
      await load();
    } catch (e) {
      setError(describeError(e));
      setRenaming(null);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteProject(deleting.id);
      setDeleting(null);
      await load();
    } catch (e) {
      setError(describeError(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container home">
      <div className="home-head">
        <div>
          <h1 className="home-title">{user ? `Hi ${user.name.split(' ')[0]}` : 'Your projects'}</h1>
          <p className="muted">Recent projects. Start a new one with the + button.</p>
        </div>
        <Link to="/new" className="btn btn-primary btn-lg home-new">+ New project</Link>
      </div>

      {error && <Alert kind="error" onClose={() => setError(null)}>{error}</Alert>}
      {projects === null && !error && <Spinner label="Loading your projects…" />}
      {projects?.length === 0 && (
        <div className="empty empty-lg">
          <h2>No projects yet</h2>
          <p>Upload a video, let AI write the subtitles, then edit, style and export them.</p>
          <Link to="/new" className="btn btn-primary">Create your first project</Link>
        </div>
      )}
      {projects && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} languages={config?.languages ?? []} onRename={() => setRenaming({ project: p, name: p.name })} onDelete={() => setDeleting(p)} />
          ))}
        </div>
      )}

      <Link to="/new" className="fab" aria-label="Create new project" title="New project" data-testid="fab-new">+</Link>

      <Dialog open={!!renaming} title="Rename project" onClose={() => setRenaming(null)}>
        <label htmlFor="rename-input">Project name</label>
        <input id="rename-input" value={renaming?.name ?? ''} maxLength={120} autoFocus onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))} onKeyDown={(e) => { if (e.key === 'Enter') void doRename(); }} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void doRename()} disabled={busy || !renaming?.name.trim()}>Save</button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        title="Delete this project?"
        message={<p>“{deleting?.name || 'Untitled project'}” with its video and subtitles will be permanently deleted. This cannot be undone.</p>}
        confirmLabel="Delete project"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

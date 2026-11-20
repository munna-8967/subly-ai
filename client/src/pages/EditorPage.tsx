import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ConfirmDialog, Dialog, ProgressBar, Spinner, StatusChip } from '../components/ui';
import { StylePanel } from '../components/StylePanel';
import { SubtitleForm } from '../components/SubtitleForm';
import type { FormApi } from '../components/SubtitleForm';
import { SubtitleList } from '../components/SubtitleList';
import { TimelinePanel } from '../components/TimelinePanel';
import { VideoStage } from '../components/VideoStage';
import { useAppConfig } from '../hooks/useAppConfig';
import { useHistory } from '../hooks/useHistory';
import { api, describeError, isOutOfCredits } from '../lib/api';
import { useAuth } from '../lib/auth';
import { takeFlash } from '../lib/flash';
import { languageName } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { transcribeCost, translateCost } from '../../../shared/credits.js';
import {
  DEFAULT_STYLE, activeSubtitles, createId, findOverlaps, formatClock, hasTranslation, mergeSubtitles, roundMs, sortSubtitles, splitSubtitle, textFor,
} from '../shared';
import type { Subtitle, SubtitleStyle, Track } from '../shared';
import type { Project } from '../types';

interface Doc { subs: Subtitle[]; style: SubtitleStyle }
type Notice = { kind: 'info' | 'warning' | 'error' | 'success'; text: string; billing?: boolean } | null;

const AUTOSAVE_KEY = 'subly.autosave';
const AUTOSAVE_DELAY_MS = 2500;

function readAutosavePref(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function EditorPage({ id }: { id: string }) {
  const { navigate } = useRouter();
  const { config } = useAppConfig();
  const { credits, refresh } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(() => takeFlash());
  const doc = useHistory<Doc>({ subs: [], style: { ...DEFAULT_STYLE } });
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [time, setTime] = useState(0);
  const [track, setTrack] = useState<Track>('original');
  const [videoFailed, setVideoFailed] = useState(false);
  const [translateTo, setTranslateTo] = useState('');
  const [confirm, setConfirm] = useState<null | 'transcribe' | 'translate'>(null);
  const [name, setName] = useState('');
  const [autosave, setAutosave] = useState(readAutosavePref);
  const [lastSaved, setLastSaved] = useState<{ at: Date; auto: boolean } | null>(null);
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  const [assetVersion, setAssetVersion] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const formApi = useRef<FormApi | null>(null);
  const wasRunning = useRef(false);

  const subs = doc.value.subs;
  const style = doc.value.style;
  const duration = project?.media?.duration ?? 0;
  const locked = project?.job?.state === 'running';
  const dirty = useMemo(() => JSON.stringify(doc.value) !== saved, [doc.value, saved]);
  const sortedSubs = subs; // always kept sorted by commit()
  const anyTranslation = useMemo(() => subs.some(hasTranslation), [subs]);
  const overlaps = useMemo(() => findOverlaps(subs), [subs]);
  const selected = useMemo(() => subs.find((s) => s.id === selectedId) ?? null, [subs, selectedId]);

  // ---------------------------------------------------------------- loading
  const load = useCallback(async () => {
    try {
      const { project: p } = await api.getProject(id);
      const list = sortSubtitles(p.subtitles ?? []);
      const next = { subs: list, style: p.style };
      setProject(p);
      setName(p.name);
      doc.reset(next);
      setSaved(JSON.stringify(next));
      setSelectedId((current) => (current && list.some((s) => s.id === current) ? current : null));
      setChecked(new Set());
      setLoadError(null);
      setAssetVersion((v) => v + 1);
      if (list.some(hasTranslation)) setTrack('translation');
    } catch (e) {
      setLoadError(describeError(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (project && !translateTo) setTranslateTo(project.targetLanguage !== 'none' ? project.targetLanguage : '');
  }, [project, translateTo]);

  // While an AI job or a video preview is being prepared, poll for status.
  const previewBusy = project?.media?.preview.state === 'processing';
  useEffect(() => {
    if (!project || !(locked || previewBusy)) return;
    wasRunning.current = locked;
    const timer = setInterval(async () => {
      try {
        const { project: p } = await api.getProject(id, true);
        const stillRunning = p.job?.state === 'running';
        if (wasRunning.current && !stillRunning) {
          wasRunning.current = false;
          await load();
          void refresh();
          if (p.job?.state === 'failed') setNotice({ kind: 'error', text: p.job.error ?? 'The AI task failed.' });
          else if (p.job?.warning) setNotice({ kind: 'warning', text: p.job.warning });
          else setNotice({ kind: 'success', text: p.job?.type === 'translate' ? 'Translation finished. Review the translated text below.' : 'Subtitles generated. Review and edit them below.' });
          if (p.job?.type === 'translate' && p.job.state === 'succeeded') setTrack('translation');
        } else {
          setProject((prev) => (prev ? { ...prev, job: p.job, media: p.media ?? prev.media, status: p.status } : prev));
        }
      } catch {
        /* transient network error: keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [project, id, locked, previewBusy, load, refresh]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ---------------------------------------------------------------- editing
  const commit = useCallback((nextSubs: Subtitle[], group?: string) => doc.commit({ subs: sortSubtitles(nextSubs), style: doc.value.style }, group), [doc]);

  /** Apply the edit form if it has unapplied changes. Returns the resulting list, or null if the form is invalid. */
  function flushForm(): Subtitle[] | null {
    const f = formApi.current;
    if (!f || !f.isDirty() || !selected) return subs;
    const next = f.apply();
    if (!next) return null;
    const list = sortSubtitles(subs.map((s) => (s.id === next.id ? next : s)));
    doc.commit({ subs: list, style }, undefined);
    return list;
  }

  function select(subId: string, seek = true) {
    if (subId !== selectedId && flushForm() === null) return;
    setSelectedId(subId);
    const sub = subs.find((s) => s.id === subId);
    if (sub && seek && videoRef.current) {
      videoRef.current.currentTime = sub.start;
      setTime(sub.start);
    }
  }

  function seek(seconds: number) {
    if (videoRef.current) videoRef.current.currentTime = seconds;
    setTime(seconds);
  }

  function addAtPlayhead() {
    if (locked || !duration) return;
    const list = flushForm();
    if (list === null) return;
    let start = roundMs(Math.min(time, Math.max(0, duration - 0.5)));
    let end = roundMs(Math.min(duration, start + 2));
    if (end - start < 0.2) {
      start = roundMs(Math.max(0, duration - 2));
      end = roundMs(duration);
    }
    const sub: Subtitle = { id: createId(), start, end, text: 'New subtitle' };
    doc.commit({ subs: sortSubtitles([...list, sub]), style }, undefined);
    setSelectedId(sub.id);
    setNotice(null);
  }

  function updateSelected(sub: Subtitle) {
    commit(subs.map((s) => (s.id === sub.id ? sub : s)));
    setNotice({ kind: 'success', text: 'Subtitle updated. Remember to save.' });
  }

  function deleteSelected() {
    if (!selected || locked) return;
    const index = subs.findIndex((s) => s.id === selected.id);
    const rest = subs.filter((s) => s.id !== selected.id);
    commit(rest);
    setSelectedId(rest[Math.min(index, rest.length - 1)]?.id ?? null);
    setChecked((prev) => { const n = new Set(prev); n.delete(selected.id); return n; });
    setNotice({ kind: 'info', text: 'Subtitle deleted. Use Undo to bring it back.' });
  }

  function splitAtPlayhead() {
    if (locked) return;
    const list = flushForm();
    if (list === null) return;
    const target = (selected && time > selected.start && time < selected.end ? list.find((s) => s.id === selected.id) : undefined) ?? activeSubtitles(list, time)[0];
    if (!target) {
      setNotice({ kind: 'warning', text: 'Move the playhead inside a subtitle to split it.' });
      return;
    }
    const result = splitSubtitle(target, time);
    if (!result.ok) {
      setNotice({ kind: 'warning', text: result.error });
      return;
    }
    doc.commit({ subs: sortSubtitles([...list.filter((s) => s.id !== target.id), ...result.parts]), style }, undefined);
    setSelectedId(result.parts[0].id);
    setNotice({ kind: 'success', text: 'Subtitle split at the playhead.' });
  }

  function mergeChecked() {
    if (locked || checked.size < 2) return;
    const list = flushForm();
    if (list === null) return;
    const picked = list.filter((s) => checked.has(s.id));
    const merged = mergeSubtitles(picked);
    if (!merged) return;
    doc.commit({ subs: sortSubtitles([...list.filter((s) => !checked.has(s.id)), merged]), style }, undefined);
    setChecked(new Set());
    setSelectedId(merged.id);
    setNotice({ kind: 'success', text: `Merged ${picked.length} subtitles.` });
  }

  /** A caption was dragged / nudged on the timeline. */
  function retime(subId: string, start: number, end: number) {
    if (locked) return;
    const list = flushForm();
    if (list === null) return;
    const next = list.map((x) => (x.id === subId ? { ...x, start: roundMs(start), end: roundMs(end) } : x));
    doc.commit({ subs: sortSubtitles(next), style }, `retime-${subId}`);
    if (videoRef.current) {
      videoRef.current.currentTime = start;
      setTime(start);
    }
  }

  const changeStyle = (next: SubtitleStyle, group: string) => doc.commit({ subs, style: next }, group);

  // ---------------------------------------------------------------- saving
  /** Save to the server. `auto` saves only what is already applied (never the half-typed edit form) and stays quiet. */
  async function save(auto = false): Promise<boolean> {
    if (saving || locked) return false;
    let list: Subtitle[] | null = subs;
    if (!auto) {
      list = flushForm();
      if (list === null) {
        setNotice({ kind: 'error', text: 'Fix the highlighted problem in the subtitle form before saving.' });
        return false;
      }
    }
    const payload = { subs: list, style };
    setSaving(true);
    try {
      const { project: p } = await api.saveProject(id, { subtitles: list, style });
      setProject((prev) => (prev ? { ...prev, ...p, subtitles: undefined } : p));
      setSaved(JSON.stringify(payload));
      setLastSaved({ at: new Date(), auto });
      setAutosaveFailed(false);
      if (!auto) setNotice({ kind: 'success', text: 'Project saved.' });
      return true;
    } catch (e) {
      if (auto) setAutosaveFailed(true);
      else setNotice({ kind: 'error', text: `Could not save: ${describeError(e)}` });
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Autosave: shortly after the last change, save what is applied. A failed autosave is retried after the next change.
  const autosaveRef = useRef<() => Promise<boolean>>(async () => false);
  autosaveRef.current = () => save(true);
  useEffect(() => {
    if (!autosave || !dirty || locked || saving) return;
    const timer = setTimeout(() => void autosaveRef.current(), autosaveFailed ? 10_000 : AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autosave, dirty, locked, saving, doc.value, autosaveFailed]);

  function toggleAutosave(on: boolean) {
    setAutosave(on);
    try {
      localStorage.setItem(AUTOSAVE_KEY, on ? 'on' : 'off');
    } catch {
      /* preference just is not remembered */
    }
  }

  async function rename() {
    const next = name.trim();
    if (!project || !next || next === project.name) {
      if (project) setName(project.name);
      return;
    }
    try {
      const { project: p } = await api.saveProject(id, { name: next });
      setProject((prev) => (prev ? { ...prev, name: p.name } : prev));
    } catch (e) {
      setNotice({ kind: 'error', text: describeError(e) });
      setName(project.name);
    }
  }

  async function goExport() {
    if (dirty && !(await save())) return;
    navigate(`/export/${id}`);
  }

  // ---------------------------------------------------------------- AI jobs
  async function runTranscribe(overwrite: boolean) {
    setConfirm(null);
    if (dirty && !(await save())) return;
    try {
      const { project: p } = await api.transcribe(id, overwrite);
      setProject(p);
      setNotice(null);
      void refresh();
    } catch (e) {
      setNotice({ kind: 'error', text: describeError(e), billing: isOutOfCredits(e) });
      void refresh();
    }
  }

  async function runTranslate(overwrite: boolean) {
    setConfirm(null);
    if (dirty && !(await save())) return;
    try {
      const { project: p } = await api.translate(id, translateTo, overwrite);
      setProject(p);
      setNotice(null);
      void refresh();
    } catch (e) {
      setNotice({ kind: 'error', text: describeError(e), billing: isOutOfCredits(e) });
      void refresh();
    }
  }

  function startTranscribe() {
    if (subs.length > 0) setConfirm('transcribe');
    else void runTranscribe(false);
  }

  function startTranslate() {
    if (!translateTo) {
      setNotice({ kind: 'warning', text: 'Choose a language to translate into.' });
      return;
    }
    if (anyTranslation) setConfirm('translate');
    else void runTranslate(false);
  }

  // ---------------------------------------------------------------- keyboard
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const target = e.target as HTMLElement | null;
    const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); addAtPlayhead(); return; }
    if (e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); splitAtPlayhead(); return; }
    if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && subs.length) {
      e.preventDefault();
      const i = subs.findIndex((s) => s.id === selectedId);
      const nextIndex = e.key === 'ArrowRight' ? Math.min(subs.length - 1, i + 1) : Math.max(0, i - 1);
      select(subs[i === -1 ? 0 : nextIndex].id);
      return;
    }
    if (inField) return; // let the browser handle undo/typing inside fields
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doc.redo(); else doc.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doc.redo(); return; }
    if (e.key === ' ' && videoRef.current && target?.tagName !== 'BUTTON' && target?.tagName !== 'VIDEO') {
      e.preventDefault();
      if (videoRef.current.paused) void videoRef.current.play().catch(() => undefined);
      else videoRef.current.pause();
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ---------------------------------------------------------------- derived view data
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => (query ? sortedSubs.filter((s) => s.text.toLowerCase().includes(query) || (s.translation ?? '').toLowerCase().includes(query)) : sortedSubs),
    [sortedSubs, query],
  );
  const active = useMemo(() => activeSubtitles(sortedSubs, time), [sortedSubs, time]);
  const activeIds = useMemo(() => new Set(active.map((s) => s.id)), [active]);
  const overlayLines = useMemo(() => active.flatMap((s) => textFor(s, track).split('\n').map((l) => l.trim()).filter(Boolean)), [active, track]);

  // ---------------------------------------------------------------- render
  if (loadError) {
    return (
      <div className="container page-message">
        <h1>Could not open this project</h1>
        <Alert kind="error">{loadError}</Alert>
        <div className="row gap">
          <button type="button" className="btn" onClick={() => void load()}>Try again</button>
          <Link to="/" className="btn btn-primary">Back to home</Link>
        </div>
      </div>
    );
  }
  if (!project) {
    return <div className="container page-message"><Spinner label="Opening project…" /></div>;
  }

  const media = project.media;
  const videoSrc = media && media.preview.state !== 'processing' && media.preview.state !== 'failed' && !videoFailed ? `${api.videoUrl(id)}?v=${assetVersion}` : null;
  const costs = config?.credits.costs;
  const transcribePrice = costs && duration > 0 ? transcribeCost(duration, costs) : null;
  const translatePrice = costs && duration > 0 ? translateCost(duration, costs) : null;
  const providerReady = config?.providers.transcription.configured ?? false;
  const translateReady = config?.providers.translation.configured ?? false;
  const showTranslationField = anyTranslation || project.targetLanguage !== 'none';

  return (
    <div className="container editor">
      <div className="editor-head">
        <div className="editor-title">
          <label htmlFor="project-name" className="sr-only">Project name</label>
          <input id="project-name" className="title-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <StatusChip status={project.status} />
          <span className={`save-state ${dirty ? 'is-dirty' : 'is-clean'}`} role="status">{saving ? 'Saving…' : autosaveFailed ? '⚠ Autosave failed, retrying…' : dirty ? (autosave ? '● Unsaved changes (autosave on)' : '● Unsaved changes') : lastSaved ? `✓ ${lastSaved.auto ? 'Autosaved' : 'Saved'} ${lastSaved.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '✓ All changes saved'}</span>
        </div>
        <div className="row gap wrap">
          <button type="button" className="btn btn-sm" onClick={doc.undo} disabled={!doc.canUndo || locked} title="Undo (Ctrl+Z)">Undo</button>
          <button type="button" className="btn btn-sm" onClick={doc.redo} disabled={!doc.canRedo || locked} title="Redo (Ctrl+Shift+Z)">Redo</button>
          <label className="check autosave-toggle"><input type="checkbox" checked={autosave} onChange={(e) => toggleAutosave(e.target.checked)} /> Autosave</label>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={!dirty || saving || locked} title="Save (Ctrl+S)" data-testid="save">Save project</button>
          <button type="button" className="btn btn-sm" onClick={() => void goExport()} disabled={saving}>Export →</button>
        </div>
      </div>

      {notice && <Alert kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}{notice.billing && <> <Link to="/billing">Get credits</Link></>}</Alert>}
      {!media && <Alert kind="warning" title="This project has no video.">The upload did not finish. Delete it from the home screen and create a new project.</Alert>}
      {locked && (
        <div className="alert alert-info job-banner" role="status">
          <div>
            <strong>{project.job?.type === 'translate' ? 'Translating' : project.job?.type === 'prepare' ? 'Preparing video' : 'Transcribing'}…</strong> {project.job?.message}
            <ProgressBar value={null} label="AI task in progress" />
            <span className="small muted">Editing is paused until this finishes. You can leave this page; the task keeps running on the server.</span>
          </div>
        </div>
      )}
      {project.job?.state === 'failed' && !locked && <Alert kind="error" title="Last AI task failed.">{project.job.error}</Alert>}
      {media?.preview.state === 'processing' && <Alert kind="info"><Spinner label="Preparing a browser-friendly preview of your video… this page updates automatically." /></Alert>}
      {(media?.preview.state === 'failed' || videoFailed) && <Alert kind="warning" title="Video preview unavailable.">{media?.preview.error ?? 'Your browser could not play this video.'} You can still edit subtitles using the list and timeline.</Alert>}
      {media && !media.hasAudio && <Alert kind="warning">This video has no audio track, so AI transcription is not possible. Add subtitles manually.</Alert>}
      {overlaps.size > 0 && <Alert kind="warning">{overlaps.size} subtitle{overlaps.size === 1 ? ' overlaps' : 's overlap'} the one before {overlaps.size === 1 ? 'it' : 'them'}. That is allowed, but check the timing.</Alert>}

      <div className="editor-grid">
        <div className="editor-main">
          <VideoStage videoRef={videoRef} src={videoSrc} width={media?.width ?? 0} height={media?.height ?? 0} style={style} lines={overlayLines} onTime={setTime} onError={() => setVideoFailed(true)} />
          <div className="row between small muted playback-info">
            <span>Playhead {formatClock(time)} / {formatClock(duration)}</span>
            {anyTranslation && (
              <span className="segmented" role="radiogroup" aria-label="Preview track">
                <label className={track === 'original' ? 'on' : ''}><input type="radio" name="track" checked={track === 'original'} onChange={() => setTrack('original')} />Original</label>
                <label className={track === 'translation' ? 'on' : ''}><input type="radio" name="track" checked={track === 'translation'} onChange={() => setTrack('translation')} />Translation</label>
              </span>
            )}
          </div>
          {duration > 0 && (
            <TimelinePanel
              subtitles={sortedSubs}
              duration={duration}
              time={time}
              selectedId={selectedId}
              track={track}
              stripUrl={media ? api.assetUrl(id, 'strip', `${assetVersion}-${Math.round(duration * 10)}`) : null}
              waveformUrl={media?.hasAudio ? api.assetUrl(id, 'waveform', `${assetVersion}-${Math.round(duration * 10)}`) : null}
              disabled={locked}
              onSeek={seek}
              onSelect={(sid) => select(sid)}
              onTiming={retime}
            />
          )}

          <details className="card panel" open>
            <summary><h2>Subtitle style</h2></summary>
            <StylePanel style={style} disabled={locked} onChange={changeStyle} onReset={() => changeStyle({ ...DEFAULT_STYLE }, 'style-reset')} />
          </details>
        </div>

        <div className="editor-side">
          <section className="card panel" aria-labelledby="ai-heading">
            <h2 id="ai-heading">AI tools</h2>
            <div className="stack">
              <div>
                <button type="button" className="btn btn-primary" onClick={startTranscribe} disabled={locked || !media || !providerReady || !media.hasAudio}>
                  {subs.length ? 'Re-generate subtitles with AI' : 'Generate subtitles with AI'}{transcribePrice !== null ? ` (${transcribePrice} credit${transcribePrice === 1 ? '' : 's'})` : ''}
                </button>
                {!providerReady && <p className="muted small">AI transcription is not configured on this server (set <code>OPENROUTER_API_KEY</code> in <code>.env</code>). Manual editing works without it.</p>}
                {providerReady && project.detectedLanguage && <p className="muted small">Detected language: {project.detectedLanguage}. Spoken language setting: {languageName(config?.languages ?? [], project.sourceLanguage)}.</p>}
              </div>
              <div>
                <label htmlFor="translate-to">Translate subtitles to</label>
                <div className="input-group">
                  <select id="translate-to" value={translateTo} onChange={(e) => setTranslateTo(e.target.value)} disabled={locked}>
                    <option value="">Choose language…</option>
                    {config?.languages.filter((l) => l.code !== project.sourceLanguage).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select>
                  <button type="button" className="btn" onClick={startTranslate} disabled={locked || subs.length === 0 || !translateReady}>Translate{translatePrice !== null ? ` (${translatePrice})` : ''}</button>
                </div>
                {!translateReady ? <p className="muted small">Machine translation is not configured. You can still type translations yourself in the form below.</p> : <p className="muted small">{config?.providers.translation.note} The original text is never replaced - translations are stored alongside it.</p>}
              </div>
            </div>
          </section>

          <section className="card panel" aria-labelledby="list-heading">
            <div className="row between">
              <h2 id="list-heading">Subtitles <span className="muted">({subs.length})</span></h2>
              {checked.size > 0 && <button type="button" className="btn btn-sm" onClick={() => setChecked(new Set())}>Clear selection ({checked.size})</button>}
            </div>
            <label htmlFor="sub-search" className="sr-only">Search subtitles</label>
            <input id="sub-search" type="search" placeholder="Search subtitles…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <SubtitleList
              subtitles={visible}
              total={subs.length}
              selectedId={selectedId}
              checked={checked}
              activeIds={activeIds}
              overlaps={overlaps}
              onSelect={(sid) => select(sid)}
              onToggle={(sid) => setChecked((prev) => { const n = new Set(prev); if (n.has(sid)) n.delete(sid); else n.add(sid); return n; })}
            />
          </section>

          <section className="card panel" aria-labelledby="edit-heading">
            <h2 id="edit-heading">Edit subtitle</h2>
            <SubtitleForm
              subtitle={selected}
              duration={duration}
              time={time}
              showTranslation={showTranslationField}
              disabled={locked}
              registerApi={(a) => { formApi.current = a; }}
              onUpdate={updateSelected}
              onDelete={deleteSelected}
              onSplit={splitAtPlayhead}
              onAdd={addAtPlayhead}
              canMerge={checked.size >= 2}
              onMerge={mergeChecked}
            />
            <details className="shortcuts small">
              <summary>Keyboard shortcuts</summary>
              <ul>
                <li><kbd>Ctrl/⌘</kbd>+<kbd>S</kbd> save</li>
                <li><kbd>Ctrl/⌘</kbd>+<kbd>Z</kbd> undo, <kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo (outside text fields)</li>
                <li><kbd>Alt</kbd>+<kbd>N</kbd> add subtitle at playhead</li>
                <li><kbd>Alt</kbd>+<kbd>S</kbd> split at playhead</li>
                <li><kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> previous / next subtitle</li>
                <li><kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> update subtitle (in the text box)</li>
                <li><kbd>Space</kbd> play / pause (outside text fields)</li>
              </ul>
            </details>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'transcribe'}
        title="Replace existing subtitles?"
        message={<p>Generating again will <strong>replace all {subs.length} current subtitles</strong>, including your edits and translations. Unsaved changes are saved first, so you can still undo only until you leave this page.</p>}
        confirmLabel="Replace with new transcription"
        danger
        onConfirm={() => void runTranscribe(true)}
        onCancel={() => setConfirm(null)}
      />
      <Dialog open={confirm === 'translate'} title="Some subtitles already have translations" onClose={() => setConfirm(null)}>
        <div className="dialog-text"><p>Translate only the subtitles that do not have a translation yet, or replace every translation (including ones you edited)?</p></div>
        <div className="dialog-actions wrap">
          <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void runTranslate(false)} autoFocus>Only missing</button>
          <button type="button" className="btn btn-danger" onClick={() => void runTranslate(true)}>Replace all</button>
        </div>
      </Dialog>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Alert, ProgressBar } from '../components/ui';
import { audioLength, TrimPreview } from '../components/TrimPreview';
import type { TrimValue } from '../components/TrimPreview';
import { useAppConfig } from '../hooks/useAppConfig';
import { api, describeError, isOutOfCredits, uploadVideo, uploadVoiceover } from '../lib/api';
import { useAuth } from '../lib/auth';
import { setFlash } from '../lib/flash';
import { formatBytes } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { generationCost } from '../../../shared/credits.js';
import { formatClock } from '../shared';
import type { Project } from '../types';

type Step = 'media' | 'working' | 'languages' | 'generating';
const STEPS: { id: Step; label: string }[] = [
  { id: 'media', label: 'Video' },
  { id: 'languages', label: 'Languages' },
  { id: 'generating', label: 'AI subtitles' },
];

function Stepper({ step }: { step: Step }) {
  const index = step === 'working' ? 0 : STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.id} className={i < index ? 'is-done' : i === index ? 'is-current' : ''} aria-current={i === index ? 'step' : undefined}>
          <span className="step-dot">{i < index ? '✓' : i + 1}</span> {s.label}
        </li>
      ))}
    </ol>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function NewProjectPage() {
  const { config } = useAppConfig();
  const { credits, refresh } = useAuth();
  const { navigate } = useRouter();

  const [step, setStep] = useState<Step>('media');
  const [video, setVideo] = useState<File | null>(null);
  const [voice, setVoice] = useState<{ file: File; duration: number } | null>(null);
  const [duration, setDuration] = useState(0);
  const [trim, setTrim] = useState<TrimValue>({ start: 0, end: 0 });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [workLabel, setWorkLabel] = useState('');
  const [workProgress, setWorkProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [source, setSource] = useState('auto');
  const [target, setTarget] = useState('none');
  const [jobMessage, setJobMessage] = useState('Starting…');
  const [outOfCredits, setOutOfCredits] = useState(false);

  useEffect(() => () => abort.current?.abort(), []);

  const limits = config?.limits;

  function pickVideo(file: File | undefined) {
    setError(null);
    if (!file || !limits) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!limits.allowedExtensions.includes(ext)) {
      setError(`Unsupported file type “.${ext}”. Use one of: ${limits.allowedExtensions.map((e) => e.toUpperCase()).join(', ')}.`);
      return;
    }
    if (file.size > limits.maxUploadBytes) {
      setError(`This file is ${formatBytes(file.size)}. The limit on this server is ${formatBytes(limits.maxUploadBytes)}.`);
      return;
    }
    setVideo(file);
    setDuration(0);
    setTrim({ start: 0, end: 0 });
  }

  async function pickVoice(file: File | undefined) {
    setError(null);
    if (!file || !config) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!config.voiceoverExtensions.includes(ext)) {
      setError(`Unsupported voice-over type “.${ext}”. Use one of: ${config.voiceoverExtensions.map((e) => e.toUpperCase()).join(', ')}.`);
      return;
    }
    setVoice({ file, duration: await audioLength(file) });
  }

  function onVideoDuration(seconds: number) {
    setDuration(seconds);
    setTrim({ start: 0, end: seconds > 0 ? Math.round(seconds * 10) / 10 : 0 });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    pickVideo(event.dataTransfer.files[0]);
  }

  const trimmed = duration > 0 && (trim.start > 0.05 || trim.end < duration - 0.15);
  const keptSeconds = duration > 0 ? trim.end - trim.start : 0;
  const tooLong = !!limits && duration > limits.maxDurationSeconds && !trimmed;
  const trimTooLong = !!limits && keptSeconds > limits.maxDurationSeconds;

  // ---------------------------------------------------------------- step 1 -> 2: upload and prepare
  async function proceed() {
    if (!video) return;
    setError(null);
    setStep('working');
    const controller = new AbortController();
    abort.current = controller;
    let created: Project | null = null;
    try {
      setWorkLabel('Creating project…');
      setWorkProgress(null);
      created = (await api.createProject({ name: video.name.replace(/\.[^.]+$/, '').slice(0, 120) })).project;

      setWorkLabel('Uploading video…');
      setWorkProgress(0);
      let p = await uploadVideo(created.id, video, setWorkProgress, controller.signal);
      if (voice) {
        setWorkLabel('Uploading voice-over…');
        setWorkProgress(0);
        p = await uploadVoiceover(created.id, voice.file, setWorkProgress, controller.signal);
      }
      if (trimmed || voice) {
        setWorkLabel(voice ? 'Applying voice-over and trim…' : 'Trimming video…');
        setWorkProgress(null);
        const realDuration = p.media?.duration ?? duration;
        await api.prepare(created.id, { trimStart: trimmed ? trim.start : 0, trimEnd: trimmed ? Math.min(trim.end, realDuration) : realDuration, useVoiceover: !!voice });
        for (;;) {
          await sleep(1000);
          if (controller.signal.aborted) throw new Error('Cancelled.');
          p = (await api.getProject(created.id, true)).project;
          if (p.job?.state === 'running') {
            setWorkLabel(p.job.message);
            continue;
          }
          if (p.job?.state === 'failed') throw new Error(p.job.error ?? 'Preparing the video failed.');
          break;
        }
      }
      setProject(p);
      setStep('languages');
    } catch (e) {
      if (created) await api.deleteProject(created.id).catch(() => undefined);
      setProject(null);
      setError(controller.signal.aborted ? 'Cancelled.' : describeError(e));
      setStep('media');
    }
  }

  // ---------------------------------------------------------------- step 3 -> 4: generate
  const projectSeconds = project?.media?.duration ?? 0;
  const withTranslation = target !== 'none';
  const cost = config && projectSeconds > 0 ? generationCost(projectSeconds, withTranslation, config.credits.costs) : null;
  const sameLanguage = source !== 'auto' && target !== 'none' && source === target;
  const aiReady = !!config?.providers.transcription.configured && !!project?.media?.hasAudio && (!withTranslation || !!config.providers.translation.configured);
  const notEnough = cost !== null && !!credits && credits.total < cost;

  async function generate() {
    if (!project) return;
    setError(null);
    setOutOfCredits(false);
    setStep('generating');
    setJobMessage('Starting…');
    try {
      await api.saveProject(project.id, { sourceLanguage: source, targetLanguage: target });
      await api.transcribe(project.id, false);
      void refresh();
      for (;;) {
        await sleep(1500);
        const { project: p } = await api.getProject(project.id, true);
        if (p.job?.state === 'running') {
          setJobMessage(p.job.message);
          continue;
        }
        if (p.job?.state === 'failed') throw new Error(p.job.error ?? 'The AI task failed.');
        setFlash(p.job?.warning ? 'warning' : 'success', p.job?.warning ?? 'Subtitles generated. Review and edit them below.');
        void refresh();
        navigate(`/editor/${project.id}`);
        return;
      }
    } catch (e) {
      if (isOutOfCredits(e)) setOutOfCredits(true);
      setError(describeError(e));
      void refresh();
      setStep('languages');
    }
  }

  function skipToEditor() {
    if (!project) return;
    void api.saveProject(project.id, { sourceLanguage: source, targetLanguage: target }).catch(() => undefined).finally(() => navigate(`/editor/${project.id}`));
  }

  async function cancelWizard() {
    abort.current?.abort();
    if (project) await api.deleteProject(project.id).catch(() => undefined);
    navigate('/');
  }

  // ---------------------------------------------------------------- render
  return (
    <div className="container wizard">
      <div className="page-head">
        <div>
          <h1 className="wizard-title">New project</h1>
          <Stepper step={step} />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void cancelWizard()}>Cancel</button>
      </div>
      {error && <Alert kind="error" onClose={() => setError(null)}>{error}{outOfCredits && <> <Link to="/billing">Get credits</Link></>}</Alert>}

      {step === 'media' && (
        <div className="wizard-grid">
          <section className="card panel" aria-labelledby="video-heading">
            <h2 id="video-heading">1. Choose your video</h2>
            {!video ? (
              <label
                className={`dropzone${dragging ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <span className="dropzone-icon" aria-hidden="true">⬆</span>
                <strong>Upload a video</strong>
                <span className="muted small">Drag a file here or click to browse. {limits ? `${limits.allowedExtensions.map((e) => e.toUpperCase()).join(', ')} · up to ${formatBytes(limits.maxUploadBytes)} · ${Math.round(limits.maxDurationSeconds / 60)} min` : ''}</span>
                <input type="file" data-testid="video-input" accept={limits ? limits.allowedExtensions.map((e) => `.${e}`).join(',') + ',video/*' : 'video/*'} onChange={(e) => pickVideo(e.target.files?.[0])} className="file-input" />
              </label>
            ) : (
              <>
                <div className="row between gap file-row">
                  <span><strong>{video.name}</strong> <span className="muted small">{formatBytes(video.size)}</span></span>
                  <button type="button" className="btn btn-sm" onClick={() => { setVideo(null); setDuration(0); }}>Change video</button>
                </div>
                <TrimPreview file={video} duration={duration} value={trim} onChange={setTrim} onDuration={onVideoDuration} />
                {tooLong && <Alert kind="warning">This video is {formatClock(duration)} long; the limit is {Math.round((limits?.maxDurationSeconds ?? 0) / 60)} minutes. Use the trim sliders to keep a shorter part.</Alert>}
                {trimTooLong && <Alert kind="warning">The selected part is still longer than {Math.round((limits?.maxDurationSeconds ?? 0) / 60)} minutes.</Alert>}
              </>
            )}
          </section>

          <section className="card panel" aria-labelledby="vo-heading">
            <h2 id="vo-heading">Voice-over <span className="muted small">(optional)</span></h2>
            <p className="muted small">Replace the video’s own sound with a separate recording. It starts at the beginning of the part you keep.</p>
            {voice ? (
              <div className="stack">
                <div className="row between gap file-row">
                  <span><strong data-testid="voice-name">{voice.file.name}</strong> <span className="muted small">{formatBytes(voice.file.size)}{voice.duration > 0 ? ` · ${formatClock(voice.duration)}` : ''}</span></span>
                  <button type="button" className="btn btn-sm" onClick={() => setVoice(null)}>Remove</button>
                </div>
                <VoicePlayer file={voice.file} />
                {voice.duration > 0 && keptSeconds > 0 && voice.duration < keptSeconds - 1 && <p className="field-warn">The voice-over is shorter than the video; the rest will be silent.</p>}
                {voice.duration > 0 && keptSeconds > 0 && voice.duration > keptSeconds + 1 && <p className="field-warn">The voice-over is longer than the video; the extra part will be cut off.</p>}
              </div>
            ) : (
              <label className="btn file-btn">
                Add voice-over file
                <input type="file" data-testid="voice-input" className="file-input" accept={(config?.voiceoverExtensions ?? []).map((e) => `.${e}`).join(',') + ',audio/*'} onChange={(e) => void pickVoice(e.target.files?.[0])} />
              </label>
            )}
            <div className="wizard-actions">
              <button type="button" className="btn btn-primary btn-lg" disabled={!video || tooLong || trimTooLong || !config} onClick={() => void proceed()} data-testid="continue-media">Continue</button>
              {!video && <p className="muted small">Choose a video to continue.</p>}
              {video && (trimmed || voice) && <p className="muted small">Continue uploads the video and applies {trimmed ? 'your trim' : ''}{trimmed && voice ? ' and ' : ''}{voice ? 'the voice-over' : ''}. This changes the stored copy, not the file on your computer.</p>}
            </div>
          </section>
        </div>
      )}

      {step === 'working' && (
        <section className="card panel working" aria-live="polite">
          <h2>{workLabel}</h2>
          <ProgressBar value={workProgress} label={workLabel} />
          {workProgress !== null && <p className="muted small">{Math.round(workProgress * 100)}%</p>}
          <button type="button" className="btn btn-sm" onClick={() => abort.current?.abort()}>Cancel</button>
        </section>
      )}

      {step === 'languages' && project && (
        <div className="wizard-grid">
          <section className="card panel" aria-labelledby="lang-heading">
            <h2 id="lang-heading">2. Languages</h2>
            <label htmlFor="source-language">Language spoken in the video</label>
            <select id="source-language" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="auto">Auto-detect</option>
              {config?.languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
            <label htmlFor="target-language">Subtitle language</label>
            <select id="target-language" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="none">Same as the video (no translation)</option>
              {config?.languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
            {sameLanguage && <p className="field-error">The video and subtitle languages are the same. Choose “Same as the video”, or a different language.</p>}
            <p className="muted small">Subtitles are always written in the spoken language first; a translation is added alongside, and you can show either one.</p>
          </section>
          <section className="card panel" aria-labelledby="cost-heading">
            <h2 id="cost-heading">3. Generate subtitles</h2>
            <p>
              <strong>{project.name}</strong>
              {project.media && <span className="muted"> · {formatClock(project.media.duration)}{project.media.prepared ? ' (after trim)' : ''}</span>}
            </p>
            {cost !== null && (
              <div className="cost-box" data-testid="cost-box">
                <span>This will use</span>
                <strong className="cost-number">{cost} credit{cost === 1 ? '' : 's'}</strong>
                <span className="muted small">You have {credits?.total ?? '…'}. Credits are refunded automatically if generation fails.</span>
              </div>
            )}
            {notEnough && <Alert kind="warning">Not enough credits. <Link to="/billing">Get more credits</Link> or continue to the editor and type subtitles by hand (free).</Alert>}
            {!config?.providers.transcription.configured && <Alert kind="warning">AI transcription is not configured on this server (the owner must set <code>OPENROUTER_API_KEY</code>). You can still write subtitles by hand.</Alert>}
            {config?.providers.transcription.configured && withTranslation && !config.providers.translation.configured && <Alert kind="warning">AI translation is not configured on this server.</Alert>}
            {project.media && !project.media.hasAudio && <Alert kind="warning">This video has no audio track, so AI transcription is not possible.</Alert>}
            <div className="wizard-actions row gap wrap">
              <button type="button" className="btn btn-primary btn-lg" onClick={() => void generate()} disabled={!aiReady || sameLanguage || notEnough} data-testid="generate">Generate subtitles</button>
              <button type="button" className="btn" onClick={skipToEditor}>Skip AI, open editor</button>
            </div>
          </section>
        </div>
      )}

      {step === 'generating' && (
        <section className="card panel working" aria-live="polite" data-testid="generating">
          <h2>Generating subtitles…</h2>
          <ProgressBar value={null} label="Generating subtitles" />
          <p>{jobMessage}</p>
          <p className="muted small">This can take a few minutes for long videos. You can leave this page: the task keeps running and the project will be on your home screen.</p>
          <Link to="/" className="btn btn-sm">Go to my projects</Link>
        </section>
      )}
    </div>
  );
}

function VoicePlayer({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <audio src={url} controls preload="metadata" aria-label="Voice-over preview" className="audio-player" /> : null;
}

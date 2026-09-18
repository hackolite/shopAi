import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cadApi } from './api/cad';
import {
  type AgentCapabilityReport,
  platformApi,
  type McpServerDescription,
  type PlatformDashboard,
  type PlatformOAuthProvider,
  type PlatformProjectSummary,
  type PlatformUser,
} from './api/platform';
import StudioApp from './StudioApp';

type AuthMode = 'login' | 'signup';
type ViewMode = 'landing' | 'studio';

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/30">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

export default function App() {
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false);
  const [hasUsers, setHasUsers] = useState(false);
  const [currentUser, setCurrentUser] = useState<PlatformUser | null>(null);
  const [dashboard, setDashboard] = useState<PlatformDashboard | null>(null);
  const [mcpDescription, setMcpDescription] = useState<McpServerDescription | null>(null);
  const [oauthProviders, setOauthProviders] = useState<PlatformOAuthProvider[]>([]);
  const [agentCapabilityReport, setAgentCapabilityReport] = useState<AgentCapabilityReport | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [viewMode, setViewMode] = useState<ViewMode>('landing');
  const [studioProjectId, setStudioProjectId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [authForm, setAuthForm] = useState({
    name: '',
    email: '',
    password: '',
  });
  const [projectName, setProjectName] = useState('');
  const [catalogName, setCatalogName] = useState('');
  const [catalogDescription, setCatalogDescription] = useState('');
  const [catalogProjectId, setCatalogProjectId] = useState<string>('');
  const [simulationName, setSimulationName] = useState('');
  const [simulationDescription, setSimulationDescription] = useState('');
  const [simulationProjectId, setSimulationProjectId] = useState<string>('');
  const [agentProvider, setAgentProvider] = useState('github-copilot');
  const [agentTargetType, setAgentTargetType] = useState('workspace');
  const [agentTargetId, setAgentTargetId] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');

  const loadAuthenticatedData = useCallback(async () => {
    const [dashboardData, mcpData] = await Promise.all([
      platformApi.getDashboard(),
      platformApi.getMcpDescription(),
    ]);
    const capabilityData = await platformApi.getAgentCapabilities(dashboardData.projects[0]?.id);
    setDashboard(dashboardData);
    setMcpDescription(mcpData);
    setOauthProviders(dashboardData.oauthProviders);
    setAgentCapabilityReport(capabilityData);
    setCatalogProjectId((current) => current || dashboardData.projects[0]?.id || '');
    setSimulationProjectId((current) => current || dashboardData.projects[0]?.id || '');
    setAgentTargetId((current) => current || dashboardData.projects[0]?.id || '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bootstrap, session] = await Promise.all([
          platformApi.bootstrap(),
          platformApi.getSession(),
        ]);
        if (cancelled) return;
        setHasUsers(bootstrap.hasUsers);
        setOauthProviders(bootstrap.oauthProviders);
        setCurrentUser(session.user);
        if (session.user) {
          await loadAuthenticatedData();
        } else if (!bootstrap.hasUsers) {
          setAuthMode('signup');
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setBootstrapLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAuthenticatedData]);

  const projectOptions = dashboard?.projects ?? [];

  const openStudio = useCallback((project: PlatformProjectSummary) => {
    setStudioProjectId(project.id);
    setViewMode('studio');
  }, []);

  const refreshDashboard = useCallback(async () => {
    await loadAuthenticatedData();
  }, [loadAuthenticatedData]);

  const handleAuthSubmit = useCallback(async () => {
    setBusy(true);
    setStatusMessage(null);
    try {
      const email = authForm.email.trim();
      const password = authForm.password;
      const name = authForm.name.trim();
      const response = authMode === 'signup'
        ? await platformApi.register(name, email, password)
        : await platformApi.login(email, password);
      setCurrentUser(response.user);
      setViewMode('landing');
      await loadAuthenticatedData();
      setStatusMessage(authMode === 'signup' ? 'Compte créé.' : 'Connexion réussie.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [authForm, authMode, loadAuthenticatedData]);

  const handleOAuth = useCallback((providerName: 'google' | 'github') => {
    const provider = oauthProviders.find((item) => item.name === providerName);
    if (!provider?.configured) {
      setStatusMessage(`OAuth ${providerName} non configuré côté serveur.`);
      return;
    }
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
    window.location.assign(`${provider.startPath}?next=${encodeURIComponent(next)}`);
  }, [oauthProviders]);

  const handleCreateProject = useCallback(async () => {
    if (!projectName.trim()) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      const created = await cadApi.createProject(projectName.trim());
      setProjectName('');
      await refreshDashboard();
      const createdProject = (await platformApi.getDashboard()).projects.find((project) => project.id === created.id);
      if (createdProject) openStudio(createdProject);
      setStatusMessage('Projet créé et rattaché à votre tenant.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [openStudio, projectName, refreshDashboard]);

  const handleCreateCatalog = useCallback(async () => {
    if (!catalogName.trim()) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      await platformApi.createCatalog({
        name: catalogName.trim(),
        description: catalogDescription.trim(),
        sourceProjectId: catalogProjectId || null,
      });
      setCatalogName('');
      setCatalogDescription('');
      await refreshDashboard();
      setStatusMessage('Catalogue enregistré en base.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [catalogDescription, catalogName, catalogProjectId, refreshDashboard]);

  const handleCreateSimulation = useCallback(async () => {
    if (!simulationName.trim()) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      await platformApi.createSimulation({
        name: simulationName.trim(),
        description: simulationDescription.trim(),
        sourceProjectId: simulationProjectId || null,
      });
      setSimulationName('');
      setSimulationDescription('');
      await refreshDashboard();
      setStatusMessage('Liste de simulations enregistrée en base.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshDashboard, simulationDescription, simulationName, simulationProjectId]);

  const handleSubmitAgentRequest = useCallback(async () => {
    if (!agentPrompt.trim()) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      await platformApi.createAgentRequest({
        provider: agentProvider,
        targetResourceType: agentTargetType,
        targetResourceId: agentTargetId || null,
        prompt: agentPrompt.trim(),
      });
      setAgentPrompt('');
      await refreshDashboard();
      setStatusMessage('Demande agent enregistrée.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [agentPrompt, agentProvider, agentTargetId, agentTargetType, refreshDashboard]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await platformApi.logout();
      setCurrentUser(null);
      setDashboard(null);
      setMcpDescription(null);
      setAgentCapabilityReport(null);
      setStudioProjectId(null);
      setViewMode('landing');
      setStatusMessage('Déconnecté.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const heroBullets = useMemo(
    () => [
      'Accueil classique SaaS avec connexion, inscription et SSO Google/GitHub.',
      'Tenant unique par utilisateur, avec plusieurs projets, catalogues et simulations stockés en base SQLite.',
      'Pont MCP HTTP et champ de prompt type Lovable pour piloter un agent sur vos ressources.',
    ],
    [],
  );

  if (!bootstrapLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-200">
        Chargement de la plateforme…
      </div>
    );
  }

  if (viewMode === 'studio' && studioProjectId) {
    return (
      <div className="relative min-h-screen">
        <button
          type="button"
          onClick={() => setViewMode('landing')}
          className="absolute right-4 top-4 z-50 rounded-full border border-white/15 bg-slate-950/85 px-4 py-2 text-xs font-medium text-white backdrop-blur hover:bg-slate-900"
        >
          ← Retour au hub
        </button>
        <StudioApp initialProjectId={studioProjectId} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#1e293b_0%,#020617_55%)] text-white">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-8">
        <header className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
              ShopAI · Retail digital twin platform
            </div>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
              Concevez, simulez et faites évoluer vos espaces retail depuis un hub multi-tenant.
            </h1>
            <p className="mt-4 max-w-2xl text-base text-slate-300 md:text-lg">
              Une page d&apos;accueil orientée produit avec authentification, workspaces, studio 3D et connecteur agent prêt à brancher.
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/5 p-5 text-sm text-slate-300 lg:max-w-md">
            <div className="mb-3 text-sm font-semibold text-white">Ce qui est désormais couvert</div>
            <ul className="space-y-2">
              {heroBullets.map((bullet) => (
                <li key={bullet} className="flex gap-2">
                  <span className="text-cyan-300">•</span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>
        </header>

        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-8 shadow-2xl shadow-slate-950/40">
            {!currentUser ? (
              <>
                <div className="grid gap-8 lg:grid-cols-[1fr_0.9fr]">
                  <div>
                    <div className="text-sm uppercase tracking-[0.3em] text-slate-500">Produit</div>
                    <h2 className="mt-3 text-3xl font-semibold text-white">Accueil cohérent pour une plateforme retail agentique.</h2>
                    <div className="mt-6 grid gap-4 sm:grid-cols-2">
                      <StatCard label="Workspaces" value="1 tenant / user" hint="Isolation simple pour démarrer." />
                      <StatCard label="Projets" value="∞" hint="Plusieurs stores et variantes par utilisateur." />
                      <StatCard label="Catalogues" value="SQLite" hint="Ressources métier stockées côté backend." />
                      <StatCard label="Agents" value="MCP HTTP" hint="Prêt à connecter Copilot ou tout autre client." />
                    </div>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
                    <div className="mb-5 flex gap-2 rounded-full bg-slate-800 p-1 text-sm">
                      <button
                        type="button"
                        onClick={() => setAuthMode('login')}
                        className={['flex-1 rounded-full px-4 py-2', authMode === 'login' ? 'bg-cyan-500 text-slate-950' : 'text-slate-300'].join(' ')}
                      >
                        Connexion
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuthMode('signup')}
                        className={['flex-1 rounded-full px-4 py-2', authMode === 'signup' ? 'bg-cyan-500 text-slate-950' : 'text-slate-300'].join(' ')}
                      >
                        Inscription
                      </button>
                    </div>

                    <div className="space-y-3">
                      {authMode === 'signup' && (
                        <input
                          value={authForm.name}
                          onChange={(event) => setAuthForm((state) => ({ ...state, name: event.target.value }))}
                          placeholder="Nom complet"
                          className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none ring-0 placeholder:text-slate-500 focus:border-cyan-400"
                        />
                      )}
                      <input
                        value={authForm.email}
                        onChange={(event) => setAuthForm((state) => ({ ...state, email: event.target.value }))}
                        placeholder="user@retail.io"
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none ring-0 placeholder:text-slate-500 focus:border-cyan-400"
                      />
                      <input
                        type="password"
                        value={authForm.password}
                        onChange={(event) => setAuthForm((state) => ({ ...state, password: event.target.value }))}
                        placeholder="Mot de passe"
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none ring-0 placeholder:text-slate-500 focus:border-cyan-400"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleAuthSubmit()}
                      className="mt-4 w-full rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {authMode === 'signup' ? 'Créer mon workspace' : 'Se connecter'}
                    </button>

                    <div className="my-4 flex items-center gap-3 text-xs text-slate-500">
                      <div className="h-px flex-1 bg-white/10" />
                      ou
                      <div className="h-px flex-1 bg-white/10" />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        disabled={!oauthProviders.find((provider) => provider.name === 'google')?.configured}
                        onClick={() => void handleOAuth('google')}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Continuer avec Google
                      </button>
                      <button
                        type="button"
                        disabled={!oauthProviders.find((provider) => provider.name === 'github')?.configured}
                        onClick={() => void handleOAuth('github')}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Continuer avec GitHub
                      </button>
                    </div>

                    <p className="mt-4 text-xs text-slate-500">
                      {hasUsers
                        ? 'Activez GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI et GITHUB_CLIENT_ID / SECRET / REDIRECT_URI pour le vrai OAuth.'
                        : 'Aucun compte détecté : créez le premier workspace pour initialiser la plateforme.'}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-400">
                      {oauthProviders.map((provider) => (
                        <span
                          key={provider.name}
                          className={[
                            'rounded-full border px-2 py-1 uppercase tracking-[0.2em]',
                            provider.configured
                              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                              : 'border-amber-400/20 bg-amber-400/10 text-amber-200',
                          ].join(' ')}
                        >
                          {provider.name} {provider.configured ? 'ready' : 'missing env'}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-8">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-sm text-cyan-300">Connecté en tant que {currentUser.email}</div>
                    <h2 className="mt-2 text-3xl font-semibold text-white">
                      {dashboard?.tenant.name ?? `${currentUser.name} workspace`}
                    </h2>
                    <p className="mt-2 text-sm text-slate-400">
                      Gérez vos projets, catalogues, simulations de passage caisse et demandes agent.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void refreshDashboard()}
                      className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:bg-white/10"
                    >
                      Actualiser
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm font-medium text-red-100 hover:bg-red-400/20"
                    >
                      Déconnexion
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-4">
                  <StatCard label="Projets" value={dashboard?.stats.projectCount ?? 0} hint="Stores, plans et variantes." />
                  <StatCard label="Catalogues" value={dashboard?.stats.catalogCount ?? 0} hint="Ressources produit métier." />
                  <StatCard label="Simulations" value={dashboard?.stats.simulationCount ?? 0} hint="Listes de scénarios caisse." />
                  <StatCard label="Demandes agent" value={dashboard?.stats.agentRequestCount ?? 0} hint="Historique Lovable-like." />
                </div>

                <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                  <SectionCard title="Projets du tenant" subtitle="Chaque projet appartient à votre workspace et reste éditable dans le studio 3D existant.">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row">
                      <input
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                        placeholder="Nouveau projet retail"
                        className="flex-1 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCreateProject()}
                        className="rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Créer un projet
                      </button>
                    </div>
                    <div className="space-y-3">
                      {projectOptions.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-500">
                          Aucun projet pour ce tenant.
                        </div>
                      ) : (
                        projectOptions.map((project) => (
                          <div key={project.id} className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:flex-row md:items-center md:justify-between">
                            <div>
                              <div className="text-base font-medium text-white">{project.name}</div>
                              <div className="mt-1 text-xs text-slate-500">
                                Mis à jour {formatDate(project.updatedAt)} · {project.catalogProducts} produits · {project.planograms} planogrammes · {project.checkoutSimulations} scénarios
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => openStudio(project)}
                              className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-400/20"
                            >
                              Ouvrir le studio
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </SectionCard>

                  <SectionCard title="Connexion agent / MCP" subtitle="Expose un point HTTP simple pour un agent externe et documente la séquence d'appel.">
                    <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                      <div className="text-xs uppercase tracking-[0.25em] text-slate-500">Endpoint</div>
                      <div className="mt-2 break-all rounded-xl bg-slate-950 px-3 py-2 font-mono text-xs text-cyan-200">
                        {mcpDescription?.endpoint ?? 'http://localhost:8000/api/platform/mcp'}
                      </div>
                    </div>
                    <ol className="mt-4 space-y-2 text-sm text-slate-300">
                      {(mcpDescription?.connectionSteps ?? []).map((step) => (
                        <li key={step} className="flex gap-3">
                          <span className="text-cyan-300">→</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <div>
                        <div className="mb-2 text-xs text-slate-500">initialize</div>
                        <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-3 text-xs text-slate-300">
                          {JSON.stringify(mcpDescription?.sampleInitialize ?? {}, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-2 text-xs text-slate-500">tools/call</div>
                        <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-3 text-xs text-slate-300">
                          {JSON.stringify(mcpDescription?.sampleToolsCall ?? {}, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </SectionCard>
                </div>

                <div className="grid gap-6 xl:grid-cols-3">
                  <SectionCard title="Catalogues" subtitle="Créez plusieurs référentiels produits rattachés à un projet ou indépendants.">
                    <div className="space-y-3">
                      <input
                        value={catalogName}
                        onChange={(event) => setCatalogName(event.target.value)}
                        placeholder="Catalogue saisonnier"
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                      <textarea
                        value={catalogDescription}
                        onChange={(event) => setCatalogDescription(event.target.value)}
                        placeholder="Description du catalogue"
                        className="min-h-24 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                      <select
                        value={catalogProjectId}
                        onChange={(event) => setCatalogProjectId(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm focus:border-cyan-400 focus:outline-none"
                      >
                        <option value="">Sans projet source</option>
                        {projectOptions.map((project) => (
                          <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCreateCatalog()}
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Enregistrer le catalogue
                      </button>
                    </div>
                    <div className="mt-4 space-y-2 text-sm text-slate-300">
                      {(dashboard?.catalogs ?? []).slice(0, 4).map((catalog) => (
                        <div key={catalog.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                          <div className="font-medium text-white">{catalog.name}</div>
                          <div className="mt-1 text-xs text-slate-500">{catalog.description || 'Sans description'}</div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="Simulations caisse" subtitle="Conservez plusieurs listes de scénarios et campagnes de passage en caisse.">
                    <div className="space-y-3">
                      <input
                        value={simulationName}
                        onChange={(event) => setSimulationName(event.target.value)}
                        placeholder="Simulation Black Friday"
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                      <textarea
                        value={simulationDescription}
                        onChange={(event) => setSimulationDescription(event.target.value)}
                        placeholder="Description de la liste"
                        className="min-h-24 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                      <select
                        value={simulationProjectId}
                        onChange={(event) => setSimulationProjectId(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm focus:border-cyan-400 focus:outline-none"
                      >
                        <option value="">Sans projet source</option>
                        {projectOptions.map((project) => (
                          <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCreateSimulation()}
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Enregistrer la simulation
                      </button>
                    </div>
                    <div className="mt-4 space-y-2 text-sm text-slate-300">
                      {(dashboard?.simulations ?? []).slice(0, 4).map((simulation) => (
                        <div key={simulation.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                          <div className="font-medium text-white">{simulation.name}</div>
                          <div className="mt-1 text-xs text-slate-500">{simulation.description || 'Sans description'}</div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="Champ agent type Lovable" subtitle="Déposez une demande d'implémentation et laissez un agent s'y connecter via le pont MCP.">
                    <div className="space-y-3">
                      <select
                        value={agentProvider}
                        onChange={(event) => setAgentProvider(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm focus:border-cyan-400 focus:outline-none"
                      >
                        <option value="github-copilot">GitHub Copilot</option>
                        <option value="claude">Claude</option>
                        <option value="custom-agent">Custom agent</option>
                      </select>
                      <select
                        value={agentTargetType}
                        onChange={(event) => setAgentTargetType(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm focus:border-cyan-400 focus:outline-none"
                      >
                        <option value="workspace">Workspace</option>
                        <option value="project">Projet</option>
                        <option value="catalog">Catalogue</option>
                        <option value="simulation">Simulation</option>
                      </select>
                      <select
                        value={agentTargetId}
                        onChange={(event) => setAgentTargetId(event.target.value)}
                        className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm focus:border-cyan-400 focus:outline-none"
                      >
                        <option value="">Aucune ressource ciblée</option>
                        {projectOptions.map((project) => (
                          <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                      </select>
                      <textarea
                        value={agentPrompt}
                        onChange={(event) => setAgentPrompt(event.target.value)}
                        placeholder="Ex: ajoute un onboarding retail, un mode KPI et un import catalogue ERP."
                        className="min-h-32 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSubmitAgentRequest()}
                        className="w-full rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Envoyer la demande à l&apos;agent
                      </button>
                    </div>
                    <div className="mt-4 space-y-2">
                      {(dashboard?.agentRequests ?? []).map((request) => (
                        <div key={request.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-white">{request.provider}</span>
                            <span className="rounded-full bg-cyan-400/10 px-2 py-1 text-[11px] uppercase tracking-[0.2em] text-cyan-200">
                              {request.status}
                            </span>
                          </div>
                          <div className="mt-2 text-sm text-slate-300">{request.prompt}</div>
                          <div className="mt-2 text-xs text-slate-500">{request.implementationNotes}</div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>
                </div>
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <SectionCard title="Fonctionnalités plateforme" subtitle="Ce qui manque d'habitude dans le MVP a été matérialisé ici.">
              <div className="space-y-3 text-sm text-slate-300">
                {[
                  'Session utilisateur persistée via cookie HTTPOnly.',
                  'OAuth Google/GitHub réel via redirections server-side quand les variables d’environnement sont présentes.',
                  'Filtrage des projets par tenant directement dans les endpoints CAD existants.',
                  'Stockage SQLite pour les métadonnées multi-tenant et les demandes agent.',
                  'Description MCP intégrée dans le backend et visible dans le hub.',
                ].map((item) => (
                  <div key={item} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    {item}
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard title="Capacité agent vérifiée" subtitle="Audit du pipeline Astra et du premier projet du tenant quand disponible.">
              <div className="space-y-3 text-sm text-slate-300">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  Script de référence : <span className="font-mono text-cyan-200">{agentCapabilityReport?.agentPilot.script ?? 'scripts/astra_build_store.py'}</span>
                </div>
                {[
                  ['Dimensionnement magasin', agentCapabilityReport?.agentPilot.supportsStoreDimensioning],
                  ['Placement mobilier', agentCapabilityReport?.agentPilot.supportsFurniturePlacement],
                  ['Implantation produit', agentCapabilityReport?.agentPilot.supportsProductPlacement],
                  ['Vérification positions absolues', agentCapabilityReport?.agentPilot.supportsAbsolutePositionVerification],
                ].map(([label, ok]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <span>{label}</span>
                    <span className={ok ? 'text-emerald-300' : 'text-amber-300'}>
                      {ok ? 'OK' : 'À vérifier'}
                    </span>
                  </div>
                ))}
                {agentCapabilityReport?.projectAudit && (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-white">{agentCapabilityReport.projectAudit.projectName}</span>
                      <span className={agentCapabilityReport.projectAudit.ok ? 'text-emerald-300' : 'text-amber-300'}>
                        {agentCapabilityReport.projectAudit.ok ? 'Audit OK' : `${agentCapabilityReport.projectAudit.issueCount} issue(s)`}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2 text-xs text-slate-400">
                      {Object.entries(agentCapabilityReport.projectAudit.checks).map(([key, value]) => (
                        <div key={key}>
                          <span className={value.ok ? 'text-emerald-300' : 'text-amber-300'}>
                            {value.ok ? '✓' : '⚠'}
                          </span>{' '}
                          {key}
                          {!value.ok && value.issues[0] ? ` — ${value.issues[0]}` : ''}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </SectionCard>

            <SectionCard title="Parcours conseillé" subtitle="Pour brancher n'importe quel agent sans ajustements côté infra.">
              <div className="space-y-3 text-sm text-slate-300">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  1. Créez votre workspace puis au moins un projet.
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  2. Copiez l&apos;endpoint MCP affiché ci-contre dans votre client agent.
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  3. Utilisez le champ agent pour stocker une demande, puis faites-la consommer via <span className="font-mono">submit_change_request</span>.
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  4. Ouvrez ensuite le studio pour modifier le projet tenant-aware.
                </div>
              </div>
            </SectionCard>

            {statusMessage && (
              <SectionCard title="Statut" subtitle="Retour du backend ou de l'action courante.">
                <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
                  {statusMessage}
                </div>
              </SectionCard>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

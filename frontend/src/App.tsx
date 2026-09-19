import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cadApi } from './api/cad';
import {
  type AgentCapabilityReport,
  platformApi,
  type AgentApiGuide,
  type PlatformDashboard,
  type PlatformOAuthProvider,
  type PlatformProjectSummary,
  type PlatformUser,
} from './api/platform';
import StudioApp from './StudioApp';
import './App.css';

type AuthMode = 'login' | 'signup';
type HubTab = 'projects' | 'layouts' | 'catalogs' | 'simulations' | 'settings';

const tabs: { id: HubTab; label: string }[] = [
  { id: 'projects', label: 'Projets' },
  { id: 'layouts', label: 'Implantations' },
  { id: 'catalogs', label: 'Catalogues' },
  { id: 'simulations', label: 'Simulations' },
  { id: 'settings', label: 'Configuration' },
];

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="hub-section">
      <div className="hub-section-heading">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="hub-field"><span>{label}</span>{children}</label>;
}

export default function App() {
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false);
  const [hasUsers, setHasUsers] = useState(false);
  const [currentUser, setCurrentUser] = useState<PlatformUser | null>(null);
  const [dashboard, setDashboard] = useState<PlatformDashboard | null>(null);
  const [agentGuide, setAgentGuide] = useState<AgentApiGuide | null>(null);
  const [oauthProviders, setOauthProviders] = useState<PlatformOAuthProvider[]>([]);
  const [agentCapabilityReport, setAgentCapabilityReport] = useState<AgentCapabilityReport | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [activeTab, setActiveTab] = useState<HubTab>('projects');
  const [studioProjectId, setStudioProjectId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' });
  const [projectName, setProjectName] = useState('');
  const [newProjectLayoutId, setNewProjectLayoutId] = useState('');
  const [newProjectCatalogId, setNewProjectCatalogId] = useState('');
  const [newProjectPedestrianDatasetId, setNewProjectPedestrianDatasetId] = useState('');
  const [projectZipName, setProjectZipName] = useState('');
  const [projectZipFile, setProjectZipFile] = useState<File | null>(null);
  const [layoutName, setLayoutName] = useState('');
  const [layoutDescription, setLayoutDescription] = useState('');
  const [layoutProjectId, setLayoutProjectId] = useState('');
  const [layoutJsonName, setLayoutJsonName] = useState('');
  const [layoutJsonDescription, setLayoutJsonDescription] = useState('');
  const [layoutJsonFile, setLayoutJsonFile] = useState<File | null>(null);
  const [catalogName, setCatalogName] = useState('');
  const [catalogDescription, setCatalogDescription] = useState('');
  const [catalogProjectId, setCatalogProjectId] = useState('');
  const [catalogCsvName, setCatalogCsvName] = useState('');
  const [catalogCsvFile, setCatalogCsvFile] = useState<File | null>(null);
  const [simulationName, setSimulationName] = useState('');
  const [simulationDescription, setSimulationDescription] = useState('');
  const [simulationProjectId, setSimulationProjectId] = useState('');
  const [simulationJsonName, setSimulationJsonName] = useState('');
  const [simulationJsonDescription, setSimulationJsonDescription] = useState('');
  const [simulationJsonFile, setSimulationJsonFile] = useState<File | null>(null);
  const [pedestrianCsvName, setPedestrianCsvName] = useState('');
  const [pedestrianCsvDescription, setPedestrianCsvDescription] = useState('');
  const [pedestrianCsvFile, setPedestrianCsvFile] = useState<File | null>(null);
  const [agentProvider, setAgentProvider] = useState('github-copilot');
  const [agentTargetType, setAgentTargetType] = useState('workspace');
  const [agentTargetId, setAgentTargetId] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');

  const loadAuthenticatedData = useCallback(async () => {
    const dashboardData = await platformApi.getDashboard();
    setDashboard(dashboardData);
    setOauthProviders(dashboardData.oauthProviders);
    const [guide, capabilities] = await Promise.all([
      platformApi.getAgentGuide(),
      platformApi.getAgentCapabilities(dashboardData.projects[0]?.id),
    ]);
    setAgentGuide(guide);
    setAgentCapabilityReport(capabilities);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bootstrap, session] = await Promise.all([platformApi.bootstrap(), platformApi.getSession()]);
        if (cancelled) return;
        setHasUsers(bootstrap.hasUsers);
        setOauthProviders(bootstrap.oauthProviders);
        setCurrentUser(session.user);
        if (session.user) await loadAuthenticatedData();
        else if (!bootstrap.hasUsers) setAuthMode('signup');
      } catch (error) {
        if (!cancelled) setStatusMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setBootstrapLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [loadAuthenticatedData]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatusMessage(null);
    try {
      await action();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleAuthSubmit = () => runAction(async () => {
    const response = authMode === 'signup'
      ? await platformApi.register(authForm.name.trim(), authForm.email.trim(), authForm.password)
      : await platformApi.login(authForm.email.trim(), authForm.password);
    setCurrentUser(response.user);
    setHasUsers(true);
    setAuthForm({ name: '', email: '', password: '' });
    setActiveTab('projects');
    await loadAuthenticatedData();
    setStatusMessage(authMode === 'signup' ? 'Votre compte est créé. Bienvenue !' : 'Connexion réussie.');
  });

  const handleOAuth = (providerName: 'google' | 'github') => {
    const provider = oauthProviders.find((item) => item.name === providerName);
    if (!provider?.configured) return;
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
    window.location.assign(`${provider.startPath}?next=${encodeURIComponent(next)}`);
  };

  const openStudio = (project: PlatformProjectSummary) => setStudioProjectId(project.id);

  const handleCreateProject = () => runAction(async () => {
    if (!projectName.trim()) return;
    const created = await cadApi.createProject(projectName.trim(), {
      storeLayoutId: newProjectLayoutId || undefined,
      catalogId: newProjectCatalogId || undefined,
      pedestrianDatasetId: newProjectPedestrianDatasetId || undefined,
    });
    setProjectName('');
    setNewProjectLayoutId('');
    setNewProjectCatalogId('');
    setNewProjectPedestrianDatasetId('');
    await loadAuthenticatedData();
    setStudioProjectId(created.id);
    setStatusMessage('Projet créé.');
  });

  const handleImportProjectZip = () => runAction(async () => {
    if (!projectZipFile || !projectZipName.trim()) return;
    const created = await cadApi.importProjectZip(projectZipName.trim(), projectZipFile);
    setProjectZipName('');
    setProjectZipFile(null);
    await loadAuthenticatedData();
    setStatusMessage('Projet importé depuis le ZIP ShopAI.');
    setStudioProjectId(created.id);
  });

  const handleDeleteProject = (projectId: string, projectName: string) => runAction(async () => {
    if (!window.confirm(`Supprimer définitivement le projet « ${projectName} » ?`)) return;
    await cadApi.deleteProject(projectId);
    await loadAuthenticatedData();
    setStatusMessage('Projet supprimé.');
  });

  const handleCreateStoreLayout = () => runAction(async () => {
    if (!layoutName.trim()) return;
    await platformApi.createStoreLayout({
      name: layoutName.trim(),
      description: layoutDescription.trim(),
      sourceProjectId: layoutProjectId || null,
    });
    setLayoutName('');
    setLayoutDescription('');
    setLayoutProjectId('');
    await loadAuthenticatedData();
    setStatusMessage('Implantation enregistrée.');
  });

  const handleImportStoreLayoutJson = () => runAction(async () => {
    if (!layoutJsonFile || !layoutJsonName.trim()) return;
    await platformApi.importStoreLayoutJson(layoutJsonFile, layoutJsonName.trim(), layoutJsonDescription.trim());
    setLayoutJsonName('');
    setLayoutJsonDescription('');
    setLayoutJsonFile(null);
    await loadAuthenticatedData();
    setStatusMessage('Implantation importée depuis le JSON ShopAI.');
  });

  const handleDeleteStoreLayout = (layoutId: string, layoutName: string) => runAction(async () => {
    if (!window.confirm(`Supprimer définitivement l’implantation « ${layoutName} » ?`)) return;
    await platformApi.deleteStoreLayout(layoutId);
    await loadAuthenticatedData();
    setStatusMessage('Implantation supprimée.');
  });

  const handleCreateCatalog = () => runAction(async () => {
    if (!catalogName.trim()) return;
    await platformApi.createCatalog({
      name: catalogName.trim(),
      description: catalogDescription.trim(),
      sourceProjectId: catalogProjectId || null,
    });
    setCatalogName('');
    setCatalogDescription('');
    await loadAuthenticatedData();
    setStatusMessage('Catalogue enregistré.');
  });

  const handleImportCatalogCsv = () => runAction(async () => {
    if (!catalogCsvFile || !catalogCsvName.trim()) return;
    await platformApi.importCatalogJson(catalogCsvFile, catalogCsvName.trim());
    setCatalogCsvName('');
    setCatalogCsvFile(null);
    await loadAuthenticatedData();
    setStatusMessage('Catalogue importé depuis le JSON assortment.');
  });

  const handleDeleteCatalog = (catalogId: string, catalogName: string) => runAction(async () => {
    if (!window.confirm(`Supprimer définitivement le catalogue « ${catalogName} » ?`)) return;
    await platformApi.deleteCatalog(catalogId);
    await loadAuthenticatedData();
    setStatusMessage('Catalogue supprimé.');
  });

  const handleCreateSimulation = () => runAction(async () => {
    if (!simulationName.trim()) return;
    await platformApi.createSimulation({
      name: simulationName.trim(),
      description: simulationDescription.trim(),
      sourceProjectId: simulationProjectId || null,
    });
    setSimulationName('');
    setSimulationDescription('');
    await loadAuthenticatedData();
    setStatusMessage('Simulation enregistrée.');
  });

  const handleImportSimulationJson = () => runAction(async () => {
    if (!simulationJsonFile || !simulationJsonName.trim()) return;
    await platformApi.importSimulationJson(simulationJsonFile, simulationJsonName.trim(), simulationJsonDescription.trim());
    setSimulationJsonName('');
    setSimulationJsonDescription('');
    setSimulationJsonFile(null);
    await loadAuthenticatedData();
    setStatusMessage('Simulation importée depuis le JSON.');
  });

  const handleDeleteSimulation = (simulationId: string, simulationNameValue: string) => runAction(async () => {
    if (!window.confirm(`Supprimer définitivement la simulation « ${simulationNameValue} » ?`)) return;
    await platformApi.deleteSimulation(simulationId);
    await loadAuthenticatedData();
    setStatusMessage('Simulation supprimée.');
  });

  const handleImportPedestrianDatasetCsv = () => runAction(async () => {
    if (!pedestrianCsvFile || !pedestrianCsvName.trim()) return;
    await platformApi.importPedestrianDatasetCsv(
      pedestrianCsvFile,
      pedestrianCsvName.trim(),
      pedestrianCsvDescription.trim(),
    );
    setPedestrianCsvName('');
    setPedestrianCsvDescription('');
    setPedestrianCsvFile(null);
    await loadAuthenticatedData();
    setStatusMessage('Dataset panier/piéton importé depuis le CSV.');
  });

  const handleDeletePedestrianDataset = (datasetId: string, datasetName: string) => runAction(async () => {
    if (!window.confirm(`Supprimer définitivement le dataset « ${datasetName} » ?`)) return;
    await platformApi.deletePedestrianDataset(datasetId);
    await loadAuthenticatedData();
    setStatusMessage('Dataset panier/piéton supprimé.');
  });

  const handleSubmitAgentRequest = () => runAction(async () => {
    if (!agentPrompt.trim()) return;
    await platformApi.createAgentRequest({
      provider: agentProvider,
      targetResourceType: agentTargetType,
      targetResourceId: agentTargetType === 'workspace' ? null : agentTargetId || null,
      prompt: agentPrompt.trim(),
    });
    setAgentPrompt('');
    await loadAuthenticatedData();
    setStatusMessage('Demande mise en attente. Un agent externe doit la récupérer ; aucune exécution automatique.');
  });

  const handleLogout = () => runAction(async () => {
    await platformApi.logout();
    setCurrentUser(null);
    setDashboard(null);
    setAgentGuide(null);
    setAgentCapabilityReport(null);
    setStudioProjectId(null);
    setActiveTab('projects');
    setProjectName('');
    setNewProjectLayoutId('');
    setNewProjectCatalogId('');
    setNewProjectPedestrianDatasetId('');
    setLayoutName('');
    setLayoutDescription('');
    setLayoutProjectId('');
    setCatalogName('');
    setCatalogDescription('');
    setCatalogProjectId('');
    setCatalogCsvName('');
    setCatalogCsvFile(null);
    setSimulationName('');
    setSimulationDescription('');
    setSimulationProjectId('');
    setPedestrianCsvName('');
    setPedestrianCsvDescription('');
    setPedestrianCsvFile(null);
    setAgentPrompt('');
    setAgentTargetId('');
    setAgentTargetType('workspace');
    setAuthMode('login');
    setStatusMessage('Vous êtes déconnecté.');
  });

  const returnToHub = () => {
    setStudioProjectId(null);
    setActiveTab('projects');
    void runAction(async () => {
      await loadAuthenticatedData();
      setStatusMessage('Vos projets sont à jour.');
    });
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  const projects = dashboard?.projects ?? [];
  const targetResources = agentTargetType === 'project' ? projects
    : agentTargetType === 'catalog' ? dashboard?.catalogs ?? []
      : agentTargetType === 'simulation' ? dashboard?.simulations ?? [] : [];
  const status = (
    <div className="hub-status" role="status" aria-live="polite" aria-atomic="true">
      {busy ? 'Opération en cours…' : statusMessage}
    </div>
  );
  const projectChoices = (
    <>
      <option value="">Sans projet source</option>
      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </>
  );

  if (!bootstrapLoaded) {
    return <div className="hub hub-loading" role="status">Chargement de votre espace…</div>;
  }

  if (studioProjectId) {
    return <StudioApp initialProjectId={studioProjectId} onBack={returnToHub} />;
  }

  return (
    <div className="hub">
      <a className="hub-skip-link" href="#hub-content">Aller au contenu</a>
      <div className="hub-container">
        <header className="hub-header">
          <div className="hub-brand"><span className="hub-brand-mark" aria-hidden="true">S</span>ShopAI</div>
          {currentUser ? (
            <div className="hub-account">
              <span>{currentUser.email}</span>
              <button type="button" disabled={busy} onClick={() => void handleLogout()}>Déconnexion</button>
            </div>
          ) : <span className="hub-muted">Votre espace de conception magasin</span>}
        </header>
        {status}

        {!currentUser ? (
          <main id="hub-content" tabIndex={-1} className="hub-welcome">
            <div className="hub-welcome-copy">
              <p className="hub-eyebrow">Concevoir, simplement</p>
              <h1>Donnez vie à votre prochain magasin.</h1>
              <p>Retrouvez vos plans, vos produits et vos simulations dans un espace de travail clair.</p>
              <ul>
                <li>Aménagez vos espaces dans le studio 3D.</li>
                <li>Organisez vos catalogues de produits.</li>
                <li>Préparez vos scénarios de passage en caisse.</li>
              </ul>
            </div>
            <section className="hub-auth" aria-labelledby="auth-title">
              <div className="hub-auth-modes" aria-label="Accès au compte">
                <button type="button" aria-pressed={authMode === 'login'} disabled={busy} onClick={() => setAuthMode('login')}>Connexion</button>
                <button type="button" aria-pressed={authMode === 'signup'} disabled={busy} onClick={() => setAuthMode('signup')}>Inscription</button>
              </div>
              <h2 id="auth-title">{authMode === 'signup' ? 'Créez votre espace' : 'Heureux de vous retrouver'}</h2>
              <p className="hub-muted">{authMode === 'signup' ? 'Un compte pour tous vos projets.' : 'Connectez-vous pour reprendre vos projets.'}</p>
              <form className="hub-form" onSubmit={(event) => { event.preventDefault(); void handleAuthSubmit(); }}>
                {authMode === 'signup' && <Field label="Nom complet">
                  <input autoComplete="name" required value={authForm.name} onChange={(event) => setAuthForm((state) => ({ ...state, name: event.target.value }))} />
                </Field>}
                <Field label="Adresse e-mail">
                  <input type="email" autoComplete="email" required value={authForm.email} onChange={(event) => setAuthForm((state) => ({ ...state, email: event.target.value }))} />
                </Field>
                <Field label="Mot de passe">
                  <input type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} required value={authForm.password} onChange={(event) => setAuthForm((state) => ({ ...state, password: event.target.value }))} />
                </Field>
                <button className="hub-primary" disabled={busy} type="submit">{authMode === 'signup' ? 'Créer mon compte' : 'Se connecter'}</button>
              </form>
              <div className="hub-divider">ou continuer avec</div>
              <div className="hub-actions">
                {(['google', 'github'] as const).map((name) => (
                  <button type="button" key={name} disabled={busy || !oauthProviders.find((provider) => provider.name === name)?.configured} onClick={() => handleOAuth(name)}>
                    {name === 'google' ? 'Google' : 'GitHub'}
                  </button>
                ))}
              </div>
              <p className="hub-small hub-muted">Les connexions grisées ne sont pas configurées.</p>
              {!hasUsers && <p className="hub-small hub-muted">Bienvenue ! Créez le premier compte pour commencer.</p>}
            </section>
          </main>
        ) : (
          <>
            <div className="hub-intro">
              <div>
                <p className="hub-eyebrow">Votre espace de travail</p>
                <h1>{dashboard?.tenant.name ?? `Bonjour ${currentUser.name}`}</h1>
                <p className="hub-muted">De la première idée au magasin prêt à simuler.</p>
              </div>
              <button type="button" disabled={busy} onClick={() => void runAction(async () => {
                await loadAuthenticatedData();
                setStatusMessage('Votre espace est à jour.');
              })}>Actualiser</button>
            </div>
            <nav className="hub-navigation" aria-label="Sections de votre espace">
              <div className="hub-tabs" role="tablist" aria-label="Espace de travail">
                {tabs.map((tab, index) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-controls={`panel-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    ref={(node) => { tabRefs.current[index] = node; }}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(event) => handleTabKey(event, index)}
                  >{tab.label}</button>
                ))}
              </div>
            </nav>
            <main id="hub-content" tabIndex={-1}>
              <div className="hub-panel" role="tabpanel" id="panel-projects" aria-labelledby="tab-projects" hidden={activeTab !== 'projects'} tabIndex={0}>
                {activeTab === 'projects' && <Section title="Vos projets" subtitle="Ouvrez un magasin dans le studio ou partez d’un nouveau plan.">
                  <form className="hub-create-project" onSubmit={(event) => { event.preventDefault(); void handleCreateProject(); }}>
                    <Field label="Nom du nouveau projet">
                      <input required placeholder="Ex. Magasin centre-ville" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
                    </Field>
                    <Field label="Implantation (facultatif)"><select value={newProjectLayoutId} onChange={(event) => setNewProjectLayoutId(event.target.value)}>
                      <option value="">Aucune – partir d’un plan vide</option>
                      {(dashboard?.storeLayouts ?? []).map((layout) => <option key={layout.id} value={layout.id}>{layout.name}</option>)}
                    </select></Field>
                    <Field label="Catalogue (facultatif)"><select value={newProjectCatalogId} onChange={(event) => setNewProjectCatalogId(event.target.value)}>
                      <option value="">Aucun – catalogue par défaut</option>
                      {(dashboard?.catalogs ?? []).map((catalog) => <option key={catalog.id} value={catalog.id}>{catalog.name}</option>)}
                    </select></Field>
                    <Field label="Dataset panier/piéton (facultatif)"><select value={newProjectPedestrianDatasetId} onChange={(event) => setNewProjectPedestrianDatasetId(event.target.value)}>
                      <option value="">Aucun</option>
                      {(dashboard?.pedestrianDatasets ?? []).map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
                    </select></Field>
                    <button className="hub-primary" type="submit" disabled={busy || !projectName.trim()}>Créer un projet</button>
                  </form>
                  <form className="hub-form hub-form-card" onSubmit={(event) => { event.preventDefault(); void handleImportProjectZip(); }}>
                    <h3>Importer un projet (ZIP ShopAI)</h3>
                    <Field label="Nom du projet importé">
                      <input required value={projectZipName} onChange={(event) => setProjectZipName(event.target.value)} placeholder="Ex. Magasin repris" />
                    </Field>
                    <Field label="Fichier ZIP"><input required type="file" accept=".zip,application/zip" onChange={(event) => setProjectZipFile(event.target.files?.[0] ?? null)} /></Field>
                    <p className="hub-small hub-muted">Archive ZIP exportée depuis ShopAI (scène, planogrammes, catalogue).</p>
                    <button className="hub-primary" type="submit" disabled={busy || !projectZipFile || !projectZipName.trim()}>Importer le ZIP</button>
                  </form>
                  {projects.length === 0 ? <div className="hub-empty"><h3>Votre premier projet commence ici</h3><p>Donnez-lui un nom ci-dessus, puis aménagez votre magasin dans le studio.</p></div> : (
                    <ul className="hub-project-grid">
                      {projects.map((project) => <li className="hub-project-card" key={project.id}>
                        <span className="hub-project-icon" aria-hidden="true">▦</span>
                        <h3>{project.name}</h3>
                        <p className="hub-small hub-muted">Mis à jour le {formatDate(project.updatedAt)}</p>
                        <div className="hub-project-details">
                          <span>{project.catalogProducts} produits</span>
                          <span>{project.planograms} planogrammes</span>
                          <span>{project.checkoutSimulations} scénarios</span>
                        </div>
                        <button type="button" disabled={busy} onClick={() => openStudio(project)} aria-label={`Ouvrir ${project.name} dans le studio`}>Ouvrir le studio <span aria-hidden="true">↗</span></button>
                        <button
                          type="button"
                          className="hub-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteProject(project.id, project.name)}
                        >
                          Supprimer
                        </button>
                      </li>)}
                    </ul>
                  )}
                </Section>}
              </div>

              <div className="hub-panel" role="tabpanel" id="panel-layouts" aria-labelledby="tab-layouts" hidden={activeTab !== 'layouts'} tabIndex={0}>
                {activeTab === 'layouts' && <Section title="Implantations (Store Layout)" subtitle="Réutilisez un plan de magasin (mobilier + implantation) indépendamment de son projet d’origine.">
                  <div className="hub-two-column hub-workspace-grid">
                    <form className="hub-form hub-form-card hub-equal-card" onSubmit={(event) => { event.preventDefault(); void handleCreateStoreLayout(); }}>
                      <h3>Nouvelle implantation</h3>
                      <Field label="Nom de l’implantation"><input required value={layoutName} onChange={(event) => setLayoutName(event.target.value)} placeholder="Ex. Implantation type hypermarché" /></Field>
                      <Field label="Description (facultatif)"><textarea rows={4} value={layoutDescription} onChange={(event) => setLayoutDescription(event.target.value)} /></Field>
                      <Field label="Depuis le projet"><select required value={layoutProjectId} onChange={(event) => setLayoutProjectId(event.target.value)}>
                        <option value="">Choisir un projet</option>
                        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </select></Field>
                      <button className="hub-primary" type="submit" disabled={busy || !layoutName.trim() || !layoutProjectId}>Enregistrer l’implantation</button>
                    </form>
                    <form className="hub-form hub-form-card hub-equal-card" onSubmit={(event) => { event.preventDefault(); void handleImportStoreLayoutJson(); }}>
                      <h3>Importer une implantation (JSON ShopAI)</h3>
                      <Field label="Nom de l’implantation"><input required value={layoutJsonName} onChange={(event) => setLayoutJsonName(event.target.value)} placeholder="Ex. Implantation fournisseur" /></Field>
                      <Field label="Description (facultatif)"><textarea rows={4} value={layoutJsonDescription} onChange={(event) => setLayoutJsonDescription(event.target.value)} /></Field>
                      <Field label="Fichier JSON"><input required type="file" accept=".json,application/json" onChange={(event) => setLayoutJsonFile(event.target.files?.[0] ?? null)} /></Field>
                      <p className="hub-small hub-muted">Format retail-layout JSON ShopAI (export « Retail Layout » du studio : store + furniture + planogrammes).</p>
                      <button className="hub-primary" type="submit" disabled={busy || !layoutJsonFile || !layoutJsonName.trim()}>Importer le JSON</button>
                    </form>
                    <div>
                      <h3>Vos implantations <span className="hub-count">{dashboard?.storeLayouts.length ?? 0}</span></h3>
                      {dashboard?.storeLayouts.length ? <ul className="hub-resource-list">{dashboard.storeLayouts.map((layout) => (
                        <li key={layout.id}>
                          <div className="hub-resource-item-header">
                            <h4>{layout.name}</h4>
                            <button type="button" className="hub-danger" disabled={busy} onClick={() => void handleDeleteStoreLayout(layout.id, layout.name)}>Supprimer</button>
                          </div>
                          <p>{layout.description || 'Sans description'}</p>
                          <span className="hub-small hub-muted">{layout.furnitureCount} meubles · Mis à jour le {formatDate(layout.updatedAt)}</span>
                        </li>
                      ))}</ul> : <p className="hub-empty">Aucune implantation enregistrée. Créez-en une depuis un projet existant.</p>}
                    </div>
                  </div>
                </Section>}
              </div>

              <div className="hub-panel" role="tabpanel" id="panel-catalogs" aria-labelledby="tab-catalogs" hidden={activeTab !== 'catalogs'} tabIndex={0}>
                {activeTab === 'catalogs' && <Section title="Catalogues" subtitle="Organisez vos référentiels produits, avec ou sans projet associé.">
                  <div className="hub-two-column hub-workspace-grid">
                    <form className="hub-form hub-form-card hub-equal-card" onSubmit={(event) => { event.preventDefault(); void handleCreateCatalog(); }}>
                      <h3>Nouveau catalogue</h3>
                      <Field label="Nom du catalogue"><input required value={catalogName} onChange={(event) => setCatalogName(event.target.value)} placeholder="Ex. Collection printemps" /></Field>
                      <Field label="Description (facultatif)"><textarea rows={4} value={catalogDescription} onChange={(event) => setCatalogDescription(event.target.value)} /></Field>
                      <Field label="Projet source (facultatif)"><select value={catalogProjectId} onChange={(event) => setCatalogProjectId(event.target.value)}>{projectChoices}</select></Field>
                      <button className="hub-primary" type="submit" disabled={busy || !catalogName.trim()}>Enregistrer le catalogue</button>
                    </form>
                    <form className="hub-form hub-form-card hub-equal-card" onSubmit={(event) => { event.preventDefault(); void handleImportCatalogCsv(); }}>
                      <h3>Importer un catalogue assortment.json</h3>
                      <Field label="Nom du catalogue"><input required value={catalogCsvName} onChange={(event) => setCatalogCsvName(event.target.value)} placeholder="Ex. Assortiment fournisseur" /></Field>
                      <Field label="Fichier JSON"><input required type="file" accept=".json,application/json" onChange={(event) => setCatalogCsvFile(event.target.files?.[0] ?? null)} /></Field>
                      <p className="hub-small hub-muted">Accepte le format brut `assortment.json` (barcode, product_name, image_url, etc.) et aussi un objet JSON déjà normalisé avec une clé `products`.</p>
                      <button className="hub-primary" type="submit" disabled={busy || !catalogCsvFile || !catalogCsvName.trim()}>Importer le JSON</button>
                    </form>
                    <div>
                      <h3>Vos catalogues <span className="hub-count">{dashboard?.catalogs.length ?? 0}</span></h3>
                      {dashboard?.catalogs.length ? <ul className="hub-resource-list">{dashboard.catalogs.map((catalog) => (
                        <li key={catalog.id}>
                          <div className="hub-resource-item-header">
                            <h4>{catalog.name}</h4>
                            <button type="button" className="hub-danger" disabled={busy} onClick={() => void handleDeleteCatalog(catalog.id, catalog.name)}>Supprimer</button>
                          </div>
                          <p>{catalog.description || 'Sans description'}</p>
                          <span className="hub-small hub-muted">{catalog.productCount} produits · Mis à jour le {formatDate(catalog.updatedAt)}</span>
                        </li>
                      ))}</ul> : <p className="hub-empty">Aucun catalogue pour le moment. Créez votre premier référentiel.</p>}
                    </div>
                  </div>
                </Section>}
              </div>

              <div className="hub-panel" role="tabpanel" id="panel-simulations" aria-labelledby="tab-simulations" hidden={activeTab !== 'simulations'} tabIndex={0}>
                {activeTab === 'simulations' && <Section title="Simulations" subtitle="Préparez vos listes de scénarios de passage en caisse et vos datasets panier/piéton.">
                  <div className="hub-two-column hub-workspace-grid">
                    <form className="hub-form hub-form-card hub-equal-card" onSubmit={(event) => { event.preventDefault(); void handleCreateSimulation(); }}>
                      <h3>Nouvelle simulation</h3>
                      <Field label="Nom de la simulation"><input required value={simulationName} onChange={(event) => setSimulationName(event.target.value)} placeholder="Ex. Affluence du samedi" /></Field>
                      <Field label="Description (facultatif)"><textarea rows={4} value={simulationDescription} onChange={(event) => setSimulationDescription(event.target.value)} /></Field>
                      <Field label="Projet source (facultatif)"><select value={simulationProjectId} onChange={(event) => setSimulationProjectId(event.target.value)}>{projectChoices}</select></Field>
                      <button className="hub-primary" type="submit" disabled={busy || !simulationName.trim()}>Enregistrer la simulation</button>
                    </form>
                    <form className="hub-form hub-form-card hub-equal-card" onSubmit={(event) => { event.preventDefault(); void handleImportSimulationJson(); }}>
                      <h3>Importer une simulation (JSON)</h3>
                      <Field label="Nom de la simulation"><input required value={simulationJsonName} onChange={(event) => setSimulationJsonName(event.target.value)} placeholder="Ex. Scénarios caisses été" /></Field>
                      <Field label="Description (facultatif)"><textarea rows={4} value={simulationJsonDescription} onChange={(event) => setSimulationJsonDescription(event.target.value)} /></Field>
                      <Field label="Fichier JSON"><input required type="file" accept=".json,application/json" onChange={(event) => setSimulationJsonFile(event.target.files?.[0] ?? null)} /></Field>
                      <p className="hub-small hub-muted">Tableau JSON de scénarios, ou objet avec une clé « scenarios ».</p>
                      <button className="hub-primary" type="submit" disabled={busy || !simulationJsonFile || !simulationJsonName.trim()}>Importer le JSON</button>
                    </form>
                    <div>
                      <h3>Vos simulations <span className="hub-count">{dashboard?.simulations.length ?? 0}</span></h3>
                      {dashboard?.simulations.length ? <ul className="hub-resource-list">{dashboard.simulations.map((simulation) => (
                        <li key={simulation.id}>
                          <div className="hub-resource-item-header">
                            <h4>{simulation.name}</h4>
                            <button type="button" className="hub-danger" disabled={busy} onClick={() => void handleDeleteSimulation(simulation.id, simulation.name)}>Supprimer</button>
                          </div>
                          <p>{simulation.description || 'Sans description'}</p>
                          <span className="hub-small hub-muted">{simulation.scenarioCount} scénarios · Mis à jour le {formatDate(simulation.updatedAt)}</span>
                        </li>
                      ))}</ul> : <p className="hub-empty">Aucune simulation enregistrée. Préparez votre première liste de scénarios.</p>}
                    </div>
                  </div>
                  <div className="hub-section-divider" />
                  <div>
                    <h3>Datasets panier/piéton <span className="hub-count">{dashboard?.pedestrianDatasets.length ?? 0}</span></h3>
                    <form className="hub-form hub-form-card" onSubmit={(event) => { event.preventDefault(); void handleImportPedestrianDatasetCsv(); }}>
                      <h4>Importer un dataset panier/piéton (CSV)</h4>
                      <Field label="Nom du dataset"><input required value={pedestrianCsvName} onChange={(event) => setPedestrianCsvName(event.target.value)} placeholder="Ex. Passage du samedi matin" /></Field>
                      <Field label="Description (facultatif)"><textarea rows={3} value={pedestrianCsvDescription} onChange={(event) => setPedestrianCsvDescription(event.target.value)} /></Field>
                      <Field label="CSV panier/piéton"><input required type="file" accept=".csv,text/csv" onChange={(event) => setPedestrianCsvFile(event.target.files?.[0] ?? null)} /></Field>
                      <p className="hub-small hub-muted">Colonnes requises : pedestrian_id, start_unix_ts, speed_mps. Colonnes facultatives : profile_json, ean.</p>
                      <button className="hub-primary" type="submit" disabled={busy || !pedestrianCsvName.trim() || !pedestrianCsvFile}>Importer le CSV panier/piéton</button>
                    </form>
                    {dashboard?.pedestrianDatasets.length ? <ul className="hub-resource-list">{dashboard.pedestrianDatasets.map((dataset) => (
                      <li key={dataset.id}>
                        <div className="hub-resource-item-header">
                          <h4>{dataset.name}</h4>
                          <button type="button" className="hub-danger" disabled={busy} onClick={() => void handleDeletePedestrianDataset(dataset.id, dataset.name)}>Supprimer</button>
                        </div>
                        <p>{dataset.description || 'Sans description'}</p>
                        <span className="hub-small hub-muted">{dataset.pedestrianCount} piétons · Mis à jour le {formatDate(dataset.updatedAt)}</span>
                      </li>
                    ))}</ul> : <p className="hub-empty">Aucun dataset panier/piéton importé pour le moment.</p>}
                  </div>
                </Section>}
              </div>

              <div className="hub-panel" role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={activeTab !== 'settings'} tabIndex={0}>
                {activeTab === 'settings' && <>
                  <Section title="Configuration" subtitle="Connexions et outils pour les utilisateurs avancés.">
                    <div className="hub-notice">Les demandes ci-dessous sont stockées pour un agent externe. Elles ne lancent pas l’assistant intégré du studio et ne sont pas exécutées automatiquement.</div>
                    <div className="hub-two-column">
                      <form className="hub-form hub-form-card" onSubmit={(event) => { event.preventDefault(); void handleSubmitAgentRequest(); }}>
                        <h3>Préparer une demande externe</h3>
                        <Field label="Agent destinataire"><select value={agentProvider} onChange={(event) => setAgentProvider(event.target.value)}>
                          <option value="github-copilot">GitHub Copilot</option><option value="claude">Claude</option><option value="custom-agent">Autre agent</option>
                        </select></Field>
                        <Field label="Type de ressource"><select value={agentTargetType} onChange={(event) => { setAgentTargetType(event.target.value); setAgentTargetId(''); }}>
                          <option value="workspace">Espace de travail</option><option value="project">Projet</option><option value="catalog">Catalogue</option><option value="simulation">Simulation</option>
                        </select></Field>
                        {agentTargetType !== 'workspace' && <Field label="Ressource ciblée"><select required value={agentTargetId} onChange={(event) => setAgentTargetId(event.target.value)}>
                          <option value="">Choisir une ressource</option>{targetResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
                        </select></Field>}
                        <Field label="Votre demande"><textarea required rows={5} value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} placeholder="Décrivez les changements souhaités…" /></Field>
                        <button className="hub-primary" type="submit" disabled={busy || !agentPrompt.trim()}>Enregistrer la demande</button>
                      </form>
                      <div>
                        <h3>Demandes enregistrées</h3>
                        {dashboard?.agentRequests.length ? <ul className="hub-resource-list">{dashboard.agentRequests.map((request) => <li key={request.id}>
                          <div className="hub-list-heading"><h4>{request.provider}</h4><span className="hub-badge">{request.status === 'queued' ? 'En attente' : request.status}</span></div>
                          <p>{request.prompt}</p>
                          {request.implementationNotes && <p className="hub-small hub-muted">{request.implementationNotes}</p>}
                          <span className="hub-small hub-muted">{formatDate(request.createdAt)}</span>
                        </li>)}</ul> : <p className="hub-empty">Aucune demande externe enregistrée.</p>}
                      </div>
                    </div>
                  </Section>
                  <Section title="Connexion REST / OpenAPI" subtitle="Transmettez ce guide à votre agent externe pour lui donner accès à l’API.">
                    <Field label="Adresse du schéma OpenAPI"><input readOnly value={agentGuide?.openApiUrl ?? `${window.location.origin}/openapi.json`} /></Field>
                    <ol className="hub-workflow">{(agentGuide?.workflowSteps ?? []).map((step) => <li key={step}>{step}</li>)}</ol>
                    <details className="hub-disclosure"><summary>Exemples de requêtes</summary><pre>{JSON.stringify(agentGuide?.sampleRequests ?? {}, null, 2)}</pre></details>
                  </Section>
                  <Section title="Capacités de l’agent externe" subtitle="Vérifications du script de pilotage et du premier projet de votre espace.">
                    <p className="hub-small hub-muted">Script de référence : <code>{agentCapabilityReport?.agentPilot.script ?? 'Non disponible'}</code></p>
                    <ul className="hub-capabilities">
                      {([
                        ['Dimensionnement du magasin', agentCapabilityReport?.agentPilot.supportsStoreDimensioning],
                        ['Placement du mobilier', agentCapabilityReport?.agentPilot.supportsFurniturePlacement],
                        ['Implantation des produits', agentCapabilityReport?.agentPilot.supportsProductPlacement],
                        ['Vérification des positions', agentCapabilityReport?.agentPilot.supportsAbsolutePositionVerification],
                      ] as const).map(([label, ok]) => <li key={label}><span>{label}</span><span className="hub-badge">{ok ? 'Disponible' : 'À vérifier'}</span></li>)}
                    </ul>
                    {agentCapabilityReport?.projectAudit && <details className="hub-disclosure">
                      <summary>{agentCapabilityReport.projectAudit.projectName} — {agentCapabilityReport.projectAudit.ok ? 'Vérifications réussies' : `${agentCapabilityReport.projectAudit.issueCount} anomalie(s)`}</summary>
                      <ul className="hub-workflow">{Object.entries(agentCapabilityReport.projectAudit.checks).map(([key, value]) => <li key={key}>{key} : {value.ok ? 'OK' : value.issues.join(' · ')}</li>)}</ul>
                    </details>}
                  </Section>
                </>}
              </div>
            </main>
          </>
        )}
        <footer className="hub-footer">ShopAI · Concevez votre magasin, à votre rythme.</footer>
      </div>
    </div>
  );
}

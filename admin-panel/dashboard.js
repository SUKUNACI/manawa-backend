// ══════════════════════════════════════════════════════════════
// CONFIG & STATE
// ══════════════════════════════════════════════════════════════
const API_BASE = window.location.origin + '/api';
let currentPage = 'dashboard';
let prosCurrentPage = 1;
let clientsCurrentPage = 1;
let payCurrentPage = 1;
let auditCurrentPage = 1;
let currentRejectProId = null;
let prosDebounceTimer = null;
let clientsDebounceTimer = null;
let dashboardData = null;

const titles = {
  dashboard: 'Tableau de bord',
  'verif-id': 'Vérifications d\'identité',
  professionals: 'Professionnels',
  clients: 'Clients',
  projects: 'Projets',
  payments: 'Paiements',
  audit: 'Journal d\'audit',
  finances: 'Finances & Revenus',
  analytics: 'Analytics Métier',
  moderation: 'Modération de contenu',
  security: 'Sécurité & Conformité',
  market: 'Marché & Opportunités',
  subscriptions: 'Gestion des abonnements',
  disputes: 'Litiges & Remboursements',
  communication: 'Communication',
  reviews: 'Avis & Notation',
  companies: 'Gestion des entreprises',
  portfolio: 'Portfolios & Réalisations',
  promos: 'Codes Promo & Offres',
  'quotes-admin': 'Gestion des devis',
  push: 'Notifications Push',
  messaging: 'Messagerie',
  settings: 'Configuration & Paramètres',
  support: 'Support',
  deleted: 'Comptes supprimés',
  'create-admin': 'Créer un administrateur',
};

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
// Données d'affichage en mémoire — jamais dans localStorage/sessionStorage
let _adminUser = null;

function isLoggedIn() {
  return _adminUser !== null;
}

function logout() {
  _adminUser = null;
  fetch(API_BASE + '/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  }).catch(() => {});
  window.location.href = '/admin/login.html';
}


// ══════════════════════════════════════════════════════════════
// API HELPER
// ══════════════════════════════════════════════════════════════
async function apiCall(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const res = await fetch(API_BASE + endpoint, { ...options, headers, credentials: 'include' });

  if (res.status === 401) {
    logout();
    showToast('Session expirée, veuillez vous reconnecter', true);
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Erreur ${res.status}`);
  }

  return res.json();
}

// ══════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════
function showPage(id, el) {
  currentPage = id;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) {
    el.classList.add('active');
  } else {
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.onclick && n.onclick.toString().includes("'" + id + "'")) n.classList.add('active');
    });
  }
  document.getElementById('page-title').textContent = titles[id] || id;

  // Load data for the page
  switch (id) {
    case 'dashboard': loadDashboard(); break;
    case 'verif-id': loadVerifications(); break;
    case 'professionals': loadProfessionals(1); break;
    case 'clients': loadClients(1); break;
    case 'projects': loadProjects(1); break;
    case 'payments': loadPayments(1); loadPaymentStats(); break;
    case 'audit': loadAuditLogs(1); break;
    case 'finances': loadFinances(); break;
    case 'analytics': loadAnalytics(); break;
    case 'moderation': loadModeration(1); break;
    case 'security': loadSecurity(); break;
    case 'market': loadMarket(); break;
    case 'subscriptions': loadSubStats(); loadSubscriptions(1); break;
    case 'disputes': loadDisputeStats(); loadDisputes(1); break;
    case 'communication': loadCommunication(); break;
    case 'reviews': loadReviewStats(); loadReviews(1); break;
    case 'companies': loadCompanyStats(); loadCompanies(1); break;
    case 'portfolio': loadPortfolioStats(); loadPortfolioProjects(1); break;
    case 'promos': loadPromoStats(); loadPromos(1); break;
    case 'quotes-admin': loadQuoteStats(); loadQuotes(1); break;
    case 'push': loadPushStats(); loadPushTokens(1); break;
    case 'messaging': loadMsgStats(); loadMsgConversations(1); break;
    case 'settings': loadSettings(); break;
    case 'support': loadSupportStats(); loadSupportTickets(); break;
    case 'deleted': loadDeletedUsers(1); break;
    case 'create-admin': resetCreateAdminForm(); break;
  }

  // Bouton Export CSV — visible sur pros, clients, paiements, finances
  const exportBtn = document.getElementById('topbar-export-btn');
  exportBtn.style.display = ['professionals', 'clients', 'payments', 'finances'].includes(id) ? '' : 'none';
}

function refreshCurrentPage() {
  showPage(currentPage, null);
  showToast('Données actualisées');
}

// ══════════════════════════════════════════════════════════════
// RECHERCHE GLOBALE
// ══════════════════════════════════════════════════════════════
let globalSearchTimer = null;

function debounceGlobalSearch() {
  clearTimeout(globalSearchTimer);
  const q = document.getElementById('global-search-input').value.trim();
  if (q.length < 2) { closeGlobalSearch(); return; }
  globalSearchTimer = setTimeout(() => runGlobalSearch(q), 350);
}

function closeGlobalSearch() {
  document.getElementById('global-search-results').style.display = 'none';
}

async function runGlobalSearch(q) {
  const box = document.getElementById('global-search-results');
  box.style.display = 'block';
  box.innerHTML = '<div class="loading-spinner" style="padding:20px;"></div>';

  try {
    const [pros, clients, projects] = await Promise.all([
      apiCall('/admin/professionals?search=' + encodeURIComponent(q) + '&limit=3'),
      apiCall('/admin/users?role=CLIENT&search=' + encodeURIComponent(q) + '&limit=3'),
      apiCall('/admin/projects?search=' + encodeURIComponent(q) + '&limit=3'),
    ]);

    let html = '';

    if (pros.professionals && pros.professionals.length > 0) {
      html += '<div style="padding:10px 14px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border);">Professionnels</div>';
      pros.professionals.forEach(p => {
        const u = p.user;
        html += '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);" onmouseenter="this.style.background=\'var(--card)\'" onmouseleave="this.style.background=\'\'" onclick="closeGlobalSearch();showPage(\'professionals\',null);setTimeout(()=>viewProfessional(\'' + p.id + '\'),300)">'
          + '<strong style="color:var(--white);font-size:13px;">' + escHtml(u.firstName + ' ' + u.lastName) + '</strong>'
          + '<span style="font-size:11px;color:var(--orange);margin-left:8px;">' + escHtml(p.trade || '') + '</span>'
          + '<br><span style="font-size:11px;color:var(--muted);">' + escHtml(u.email) + '</span>'
          + '</div>';
      });
    }

    if (clients.users && clients.users.length > 0) {
      html += '<div style="padding:10px 14px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border);">Clients</div>';
      clients.users.forEach(u => {
        html += '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);" onmouseenter="this.style.background=\'var(--card)\'" onmouseleave="this.style.background=\'\'" onclick="closeGlobalSearch();showPage(\'clients\',null);setTimeout(()=>{document.getElementById(\'clients-search\').value=\'' + escAttr(u.email) + '\';loadClients(1);},300)">'
          + '<strong style="color:var(--white);font-size:13px;">' + escHtml(u.firstName + ' ' + u.lastName) + '</strong>'
          + '<br><span style="font-size:11px;color:var(--muted);">' + escHtml(u.email) + (u.city ? ' · ' + escHtml(u.city) : '') + '</span>'
          + '</div>';
      });
    }

    if (projects.projects && projects.projects.length > 0) {
      html += '<div style="padding:10px 14px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border);">Projets</div>';
      projects.projects.forEach(p => {
        html += '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);" onmouseenter="this.style.background=\'var(--card)\'" onmouseleave="this.style.background=\'\'" onclick="closeGlobalSearch();showPage(\'projects\',null);setTimeout(()=>viewProject(\'' + p.id + '\'),300)">'
          + '<strong style="color:var(--white);font-size:13px;">' + escHtml(p.title) + '</strong>'
          + '<span style="margin-left:8px;">' + getProjectStatusBadge(p.status) + '</span>'
          + '<br><span style="font-size:11px;color:var(--muted);">' + escHtml(p.city || '') + (p.tradeNeeded ? ' · ' + escHtml(p.tradeNeeded) : '') + '</span>'
          + '</div>';
      });
    }

    if (!html) {
      html = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">Aucun résultat pour "' + escHtml(q) + '"</div>';
    }

    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = '<div style="padding:16px;color:var(--red);font-size:13px;">Erreur de recherche</div>';
  }
}

// Fermer en cliquant ailleurs
document.addEventListener('click', e => {
  if (!e.target.closest('#global-search-input') && !e.target.closest('#global-search-results')) {
    closeGlobalSearch();
  }
});

// ══════════════════════════════════════════════════════════════
// EXPORT CSV
// ══════════════════════════════════════════════════════════════
async function exportCurrentPage() {
  try {
    let rows = [], headers = [], filename = 'export.csv';

    if (currentPage === 'professionals') {
      showToast('Export en cours…');
      const trade  = document.getElementById('pros-trade-filter')?.value  || '';
      const status = document.getElementById('pros-status-filter')?.value || '';
      const search = document.getElementById('pros-search')?.value.trim() || '';
      const params = new URLSearchParams({ limit: 5000 });
      if (trade)  params.set('trade', trade);
      if (status) params.set('identityStatus', status);
      if (search) params.set('search', search);
      const data = await apiCall('/admin/professionals?' + params);
      headers = ['ID', 'Prénom', 'Nom', 'Email', 'Téléphone', 'Métier', 'Ville', 'Statut ID', 'Décennale', 'Premium', 'Score confiance', 'Inscrit le'];
      rows = (data.professionals || []).map(p => [
        p.user.id, p.user.firstName, p.user.lastName, p.user.email, p.user.phone || '',
        p.trade || '', p.user.city || '', p.identityStatus,
        p.decennaleVerified ? 'Oui' : 'Non',
        p.subscription && p.subscription.status === 'ACTIVE' ? 'Oui' : 'Non',
        p.trustScore?.total ?? '',
        new Date(p.user.createdAt).toLocaleDateString('fr-FR'),
      ]);
      const suffix = [trade, status, search].filter(Boolean).join('_').replace(/\s+/g, '-').toLowerCase();
      filename = 'professionnels' + (suffix ? '_' + suffix : '') + '_' + new Date().toISOString().slice(0,10) + '.csv';

    } else if (currentPage === 'clients') {
      showToast('Export en cours…');
      const search = document.getElementById('clients-search')?.value.trim() || '';
      const params = new URLSearchParams({ role: 'CLIENT', limit: 5000 });
      if (search) params.set('search', search);
      const data = await apiCall('/admin/users?' + params);
      headers = ['ID', 'Prénom', 'Nom', 'Email', 'Téléphone', 'Ville', 'Email vérifié', 'Statut', 'Inscrit le'];
      rows = (data.users || []).map(u => [
        u.id, u.firstName, u.lastName, u.email, u.phone || '',
        u.city || '', u.emailVerified ? 'Oui' : 'Non',
        u.suspended ? 'Suspendu' : 'Actif',
        new Date(u.createdAt).toLocaleDateString('fr-FR'),
      ]);
      filename = 'clients' + (search ? '_' + search.replace(/\s+/g, '-').toLowerCase() : '') + '_' + new Date().toISOString().slice(0,10) + '.csv';

    } else if (currentPage === 'payments') {
      showToast('Export en cours…');
      const status = document.getElementById('pay-status-filter')?.value || '';
      const type   = document.getElementById('pay-type-filter')?.value   || '';
      const search = document.getElementById('pay-search')?.value.trim() || '';
      const params = new URLSearchParams({ limit: 5000 });
      if (status) params.set('status', status);
      if (type)   params.set('type', type);
      if (search) params.set('search', search);
      const data = await apiCall('/admin/payments?' + params);
      headers = ['ID', 'Montant (FCFA)', 'Type', 'Statut', 'Professionnel', 'Email pro', 'Projet', 'Ref GeniusPay', 'Date'];
      rows = (data.payments || []).map(p => {
        const pro = p.quote?.professional?.user;
        const proName  = pro ? pro.firstName + ' ' + pro.lastName : '';
        const proEmail = pro ? pro.email : '';
        const projectTitle = p.quote?.project?.title || '';
        return [
          p.id, p.amount, p.isDeposit ? 'Acompte 30%' : 'Solde 70%', p.status,
          proName, proEmail, projectTitle, p.geniuspayRef || '',
          new Date(p.createdAt).toLocaleDateString('fr-FR'),
        ];
      });
      const suffix = [status, type].filter(Boolean).join('_');
      filename = 'paiements' + (suffix ? '_' + suffix.toLowerCase() : '') + '_' + new Date().toISOString().slice(0,10) + '.csv';

    } else if (currentPage === 'finances') {
      exportFinancesCSV();
      return;
    }

    if (rows.length === 0) { showToast('Aucune donnée à exporter', true); return; }

    const csv = [headers, ...rows].map(r =>
      r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')
    ).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('Export téléchargé — ' + rows.length + ' lignes');
  } catch (err) {
    showToast('Erreur export : ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    const data = await apiCall('/admin/dashboard');
    dashboardData = data;

    // KPIs ligne 1
    document.getElementById('kpi-pros').textContent = formatNumber(data.users.professionals);
    document.getElementById('kpi-clients').textContent = formatNumber(data.users.clients);
    document.getElementById('kpi-projects').textContent = formatNumber(data.projects.total);
    document.getElementById('kpi-projects-delta').textContent = '▲ ' + data.projects.open + ' ouverts';
    document.getElementById('kpi-revenue').textContent = formatCurrency(data.payments.revenue);

    // KPIs ligne 2
    document.getElementById('kpi-premium').textContent = formatNumber(data.subscriptions.activePremium);
    document.getElementById('kpi-quotes').textContent = formatNumber(data.quotes.total);
    document.getElementById('kpi-payments-ok').textContent = formatNumber(data.payments.total);
    document.getElementById('kpi-promos').textContent = formatNumber(data.promos?.active ?? '--');
    document.getElementById('kpi-portfolio').textContent = formatNumber(data.portfolio?.total ?? '--');

    // Graphique CA mensuel
    try {
      const stats = await apiCall('/admin/payments/stats');
      const revenueByMonth = stats.revenueByMonth || {};
      const now = new Date();
      const months = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        const shortLabel = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'][d.getMonth()];
        months.push({ key, label: shortLabel, val: revenueByMonth[key] || 0 });
      }
      const maxRev = Math.max(...months.map(m => m.val), 1);
      const totalRev = months.reduce((s, m) => s + m.val, 0);
      document.getElementById('dashboard-revenue-total').textContent = 'Total 12 mois : ' + formatCurrency(totalRev) + ' FCFA';
      document.getElementById('dashboard-revenue-chart').innerHTML = months.map(m =>
        '<div class="bar-item" style="flex:1;">' +
          '<div style="font-size:9px;color:var(--orange);font-weight:600;margin-bottom:2px;">' + (m.val > 0 ? formatCurrency(m.val) : '') + '</div>' +
          '<div style="width:100%;border-radius:6px 6px 0 0;background:' + (m.val > 0 ? 'linear-gradient(180deg,var(--green),rgba(34,197,94,0.3))' : 'rgba(255,255,255,0.04)') + ';height:' + Math.max(3, (m.val / maxRev) * 100) + '%;transition:height .5s;"></div>' +
        '</div>'
      ).join('');
      document.getElementById('dashboard-revenue-labels').innerHTML = months.map(m =>
        '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);">' + m.label + '</div>'
      ).join('');
    } catch(e) {
      document.getElementById('dashboard-revenue-chart').innerHTML = '<p style="color:var(--muted);font-size:13px;">Données indisponibles</p>';
    }

    // Alert
    if (data.pendingVerifications > 0) {
      document.getElementById('dashboard-alert').style.display = 'flex';
      document.getElementById('dashboard-alert-text').innerHTML = '<strong>' + data.pendingVerifications + ' vérification(s) en attente</strong> — des identités nécessitent votre validation.';
      document.getElementById('badge-id').textContent = data.pendingVerifications;
      document.getElementById('badge-id').style.display = '';
      document.getElementById('topbar-pending-btn').style.display = '';
      document.getElementById('topbar-pending-count').textContent = data.pendingVerifications;
    } else {
      document.getElementById('dashboard-alert').style.display = 'none';
      document.getElementById('badge-id').style.display = 'none';
      document.getElementById('topbar-pending-btn').style.display = 'none';
    }

    // Project chart
    const chartEl = document.getElementById('dashboard-projects-chart');
    const projData = [
      { label: 'Ouverts', val: data.projects.open },
      { label: 'En cours', val: data.projects.inProgress },
      { label: 'Terminés', val: data.projects.completed },
      { label: 'Annulés', val: data.projects.cancelled }
    ];
    const maxVal = Math.max(...projData.map(d => d.val), 1);
    chartEl.innerHTML = projData.map(d =>
      '<div class="bar-item"><div class="bar-val">' + d.val + '</div><div class="bar" style="height:' + Math.max(5, (d.val / maxVal) * 100) + '%"></div><div class="bar-label">' + d.label + '</div></div>'
    ).join('');

    // Donut
    const total = data.users.professionals + data.users.clients;
    const proPct = total > 0 ? Math.round((data.users.professionals / total) * 100) : 0;
    const cliPct = 100 - proPct;
    document.getElementById('dashboard-donut-chart').style.background = 'conic-gradient(var(--orange) 0% ' + proPct + '%, var(--blue) ' + proPct + '% 100%)';
    document.getElementById('dashboard-donut-legend').innerHTML =
      '<div class="dl-item"><div class="dl-dot" style="background:var(--orange)"></div>Professionnels (' + proPct + '%)</div>' +
      '<div class="dl-item"><div class="dl-dot" style="background:var(--blue)"></div>Clients (' + cliPct + '%)</div>';

    // Latest users table
    const tbody = document.getElementById('dashboard-latest-users');
    if (data.latestUsers && data.latestUsers.length > 0) {
      tbody.innerHTML = data.latestUsers.map(u => {
        const roleBadge = u.role === 'PROFESSIONAL'
          ? '<span class="badge badge-orange">Pro</span>'
          : '<span class="badge badge-blue">Client</span>';
        return '<tr><td><strong>' + escHtml(u.firstName + ' ' + u.lastName) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + escHtml(u.email) + '</span></td><td>' + roleBadge + '</td><td>' + escHtml(u.city || '-') + '</td><td>' + formatDate(u.createdAt) + '</td></tr>';
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">Aucune inscription récente</td></tr>';
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
    }
  }
}

// ══════════════════════════════════════════════════════════════
// VERIFICATIONS
// ══════════════════════════════════════════════════════════════
async function loadVerifications() {
  try {
    const data = await apiCall('/admin/professionals?identityStatus=PENDING&limit=50');
    const grid = document.getElementById('verif-grid');
    const empty = document.getElementById('verif-empty');

    if (!data.professionals || data.professionals.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    grid.innerHTML = data.professionals.map(pro => {
      const u = pro.user;
      const name = (u.firstName || '') + ' ' + (u.lastName || '');
      const tradeEmoji = getTradeEmoji(pro.trade);

      // Build doc previews
      let docsHtml = '<div class="vc-docs">';
      if (pro.idDocumentUrl) {
        docsHtml += '<div class="vc-doc" onclick="viewDocImage(\'' + escAttr(pro.idDocumentUrl) + '\', \'CNI Recto\')"><img src="' + escAttr(pro.idDocumentUrl) + '" onerror="this.style.display=\'none\';this.parentNode.innerHTML=\'🪪<span>CNI Recto</span>\'"></div>';
      } else {
        docsHtml += '<div class="vc-doc">🪪<span>CNI Recto</span></div>';
      }
      if (pro.idDocumentVersoUrl) {
        docsHtml += '<div class="vc-doc" onclick="viewDocImage(\'' + escAttr(pro.idDocumentVersoUrl) + '\', \'CNI Verso\')"><img src="' + escAttr(pro.idDocumentVersoUrl) + '" onerror="this.style.display=\'none\';this.parentNode.innerHTML=\'🪪<span>CNI Verso</span>\'"></div>';
      } else {
        docsHtml += '<div class="vc-doc">🪪<span>CNI Verso</span></div>';
      }
      if (pro.selfieUrl) {
        docsHtml += '<div class="vc-doc" onclick="viewDocImage(\'' + escAttr(pro.selfieUrl) + '\', \'Selfie\')"><img src="' + escAttr(pro.selfieUrl) + '" onerror="this.style.display=\'none\';this.parentNode.innerHTML=\'🤳<span>Selfie</span>\'"></div>';
      } else {
        docsHtml += '<div class="vc-doc">🤳<span>Selfie</span></div>';
      }
      docsHtml += '</div>';

      // Trust score
      const score = pro.trustScore ? (pro.trustScore.total || 0) : 0;
      const afterScore = Math.min(100, score + 20);

      return '<div class="verif-card" id="vc-' + pro.id + '">' +
        '<div class="vc-header">' +
          '<div class="vc-avatar">' + tradeEmoji + '</div>' +
          '<div class="vc-info">' +
            '<h3>' + escHtml(name) + '</h3>' +
            '<p>' + escHtml(pro.trade || 'Non spécifié') + ' · ' + escHtml(u.city || 'Non spécifié') + '</p>' +
            '<div class="vc-date">' + escHtml(u.email) + ' · Inscrit le ' + formatDate(u.createdAt) + '</div>' +
          '</div>' +
          '<span class="badge badge-yellow" style="margin-left:auto;">⏳ Pending</span>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;letter-spacing:1px;text-transform:uppercase;">Score de confiance</div>' +
        '<div class="vc-score-bar"><div class="vc-score-fill" style="width:' + score + '%"></div></div>' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">' + score + ' / 100 · Passera à <strong style="color:var(--orange)">' + afterScore + ' / 100</strong> après validation</div>' +
        docsHtml +
        '<div class="vc-actions">' +
          '<button class="btn btn-reject" onclick="openRejectModal(\'' + escAttr(name) + '\',\'' + pro.id + '\')">✕ Rejeter</button>' +
          '<button class="btn btn-approve" onclick="approveIdentity(\'' + pro.id + '\',\'' + escAttr(name) + '\')">✓ Approuver</button>' +
        '</div>' +
      '</div>';
    }).join('');

  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
      document.getElementById('verif-grid').innerHTML = '<div class="empty-state"><div class="es-icon">⚠️</div><p>Erreur lors du chargement</p></div>';
    }
  }
}

async function approveIdentity(proId, name) {
  try {
    await apiCall('/admin/professionals/' + proId + '/verify', { method: 'PATCH' });
    const card = document.getElementById('vc-' + proId);
    if (card) {
      card.style.opacity = '0.4';
      card.style.pointerEvents = 'none';
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.className = 'badge badge-green';
        badge.textContent = '✓ Approuvé';
      }
    }
    updatePendingBadge(-1);
    showToast('Identité de ' + name + ' validée !');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function confirmReject() {
  if (!currentRejectProId) return;
  try {
    const reason = document.getElementById('reject-reason').value + (document.getElementById('reject-notes').value ? ' — ' + document.getElementById('reject-notes').value : '');
    await apiCall('/admin/professionals/' + currentRejectProId + '/reject', { method: 'PATCH', body: JSON.stringify({ reason }) });
    const card = document.getElementById('vc-' + currentRejectProId);
    if (card) {
      card.style.opacity = '0.4';
      card.style.pointerEvents = 'none';
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.className = 'badge badge-red';
        badge.textContent = '✕ Rejeté';
      }
    }
    updatePendingBadge(-1);
    closeModal('modal-reject');
    showToast('Rejet notifié au professionnel');
  } catch (err) {
    closeModal('modal-reject');
    showToast('Erreur: ' + err.message, true);
  }
}

function updatePendingBadge(delta) {
  const badge = document.getElementById('badge-id');
  let count = parseInt(badge.textContent) || 0;
  count = Math.max(0, count + delta);
  if (count <= 0) {
    badge.style.display = 'none';
    document.getElementById('topbar-pending-btn').style.display = 'none';
  } else {
    badge.textContent = count;
    document.getElementById('topbar-pending-count').textContent = count;
  }
}

// ══════════════════════════════════════════════════════════════
// PROFESSIONALS
// ══════════════════════════════════════════════════════════════
function debouncePros() {
  clearTimeout(prosDebounceTimer);
  prosDebounceTimer = setTimeout(() => loadProfessionals(1), 400);
}

async function loadProfessionals(page) {
  prosCurrentPage = page;
  const search = document.getElementById('pros-search').value.trim();
  const trade = document.getElementById('pros-trade-filter').value;
  const status = document.getElementById('pros-status-filter').value;

  let url = '/admin/professionals?page=' + page + '&limit=15';
  if (trade) url += '&trade=' + encodeURIComponent(trade);
  if (status) url += '&identityStatus=' + encodeURIComponent(status);
  if (search) url += '&search=' + encodeURIComponent(search);

  try {
    const data = await apiCall(url);
    const tbody = document.getElementById('pros-tbody');
    const emptyEl = document.getElementById('pros-empty');
    const paginationEl = document.getElementById('pros-pagination');

    let pros = data.professionals || [];

    if (pros.length === 0) {
      tbody.innerHTML = '';
      emptyEl.style.display = 'block';
      paginationEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    tbody.innerHTML = pros.map(pro => {
      const u = pro.user;
      const name = (u.firstName || '') + ' ' + (u.lastName || '');
      const statusBadge = getStatusBadge(pro.identityStatus);
      const premiumBadge = pro.subscription && pro.subscription.status === 'ACTIVE'
        ? '<span class="badge badge-yellow" style="background:rgba(232,184,75,0.15);color:var(--gold);">⭐ Premium</span>'
        : '<span class="badge badge-muted">Gratuit</span>';
      const rating = pro.averageRating ? ('★ ' + pro.averageRating.toFixed(1) + ' (' + (pro.reviewCount || 0) + ')') : '—';
      const missions = (pro.completedMissionsCount || 0);

      const isSuspended = u.suspended;
      let actions = '';
      if (pro.identityStatus === 'PENDING') {
        actions = '<button class="btn btn-approve" onclick="event.stopPropagation();approveProFromTable(\'' + pro.id + '\',\'' + escAttr(name) + '\',this)">✓</button><button class="btn btn-reject" onclick="event.stopPropagation();openRejectModal(\'' + escAttr(name) + '\',\'' + pro.id + '\')">✕</button>';
      } else {
        actions = '<button class="btn btn-view" onclick="event.stopPropagation();viewProfessional(\'' + pro.id + '\')">👁</button>';
      }
      if (isSuspended) {
        actions += '<button class="btn btn-approve" onclick="event.stopPropagation();reactivatePro(\'' + pro.id + '\',\'' + escAttr(name) + '\')" title="Réactiver">↺</button>';
      } else {
        actions += '<button class="btn btn-reject" onclick="event.stopPropagation();suspendPro(\'' + pro.id + '\',\'' + escAttr(name) + '\')" title="Suspendre">⏸</button>';
      }
      actions += '<button class="btn btn-reject" onclick="event.stopPropagation();deleteProfessional(\'' + pro.id + '\',\'' + escAttr(name) + '\')" title="Supprimer">🗑</button>';

      return '<tr><td><span style="font-family:monospace;font-size:11px;color:var(--orange);cursor:pointer;" title="' + escAttr(u.id) + '" onclick="navigator.clipboard.writeText(\'' + escAttr(u.id) + '\');showToast(\'ID copié\')">' + escHtml(u.id.substring(0, 6)) + '</span></td><td><strong>' + escHtml(name) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + escHtml(u.email) + '</span></td><td>' + escHtml(pro.trade || '-') + '</td><td>' + escHtml(u.city || '-') + '</td><td style="color:var(--orange)">' + rating + '</td><td>' + missions + '</td><td>' + statusBadge + '</td><td>' + premiumBadge + '</td><td class="td-actions">' + actions + '</td></tr>';
    }).join('');

    // Pagination
    const pagination = data.pagination;
    if (pagination && pagination.totalPages > 1) {
      paginationEl.style.display = 'flex';
      document.getElementById('pros-page-info').textContent = 'Page ' + pagination.page + ' / ' + pagination.totalPages + ' (' + pagination.total + ' résultats)';
      document.getElementById('pros-prev').disabled = pagination.page <= 1;
      document.getElementById('pros-next').disabled = pagination.page >= pagination.totalPages;
    } else {
      paginationEl.style.display = 'none';
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
    }
  }
}

async function approveProFromTable(proId, name, btn) {
  try {
    await apiCall('/admin/professionals/' + proId + '/verify', { method: 'PATCH' });
    showToast('Identité de ' + name + ' validée !');
    loadProfessionals(prosCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function suspendPro(proId, name) {
  if (!confirm('Suspendre le compte de ' + name + ' ?')) return;
  try {
    await apiCall('/admin/professionals/' + proId + '/suspend', { method: 'PATCH' });
    showToast('Compte de ' + name + ' suspendu');
    loadProfessionals(prosCurrentPage);
    if (document.getElementById('modal-project').classList.contains('show')) viewProfessional(proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function reactivatePro(proId, name) {
  try {
    await apiCall('/admin/professionals/' + proId + '/reactivate', { method: 'PATCH' });
    showToast('Compte de ' + name + ' réactivé');
    loadProfessionals(prosCurrentPage);
    if (document.getElementById('modal-project').classList.contains('show')) viewProfessional(proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function deleteProfessional(proId, name) {
  if (!confirm('Supprimer le profil professionnel de ' + name + ' ? Cette action est irréversible.')) return;
  try {
    await apiCall('/admin/professionals/' + proId, { method: 'DELETE' });
    showToast('Profil de ' + name + ' supprimé');
    loadProfessionals(prosCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function viewProfessional(proId) {
  try {
    const data = await apiCall('/admin/professionals/' + proId);
    const u = data.user;
    const name = (u.firstName || '') + ' ' + (u.lastName || '');
    const avatar = u.avatarUrl || data.selfieUrl || null;
    const rating = data.averageRating ? data.averageRating.toFixed(1) : '—';
    const stars = data.averageRating ? '★'.repeat(Math.round(data.averageRating)) + '☆'.repeat(5 - Math.round(data.averageRating)) : '';

    let html = '<div style="display:flex;gap:20px;align-items:flex-start;margin-bottom:20px;">';
    // Photo
    html += '<div style="flex-shrink:0;">';
    if (avatar) {
      html += '<img src="' + escHtml(avatar) + '" style="width:100px;height:100px;border-radius:16px;object-fit:cover;border:2px solid var(--orange);" onerror="this.src=\'\';this.style.display=\'none\';this.parentNode.innerHTML=\'<div style=\\\'width:100px;height:100px;border-radius:16px;background:rgba(244,114,11,0.12);display:flex;align-items:center;justify-content:center;font-size:40px;\\\'>👷</div>\'">';
    } else {
      html += '<div style="width:100px;height:100px;border-radius:16px;background:rgba(244,114,11,0.12);display:flex;align-items:center;justify-content:center;font-size:40px;">👷</div>';
    }
    html += '</div>';
    // Infos principales
    html += '<div style="flex:1;">';
    html += '<h3 style="font-family:Syne,sans-serif;font-size:20px;font-weight:800;color:var(--white);margin-bottom:4px;">' + escHtml(name) + '</h3>';
    html += '<p style="color:var(--orange);font-weight:600;font-size:14px;margin-bottom:4px;">' + escHtml(data.trade || 'Non spécifié') + '</p>';
    html += '<p style="color:var(--muted);font-size:12px;">' + escHtml(u.email) + (u.phone ? ' · ' + escHtml(u.phone) : '') + '</p>';
    html += '<p style="color:var(--muted);font-size:12px;">📍 ' + escHtml(u.city || 'Non spécifié') + '</p>';
    html += '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">' + getStatusBadge(data.identityStatus);
    if (data.subscription && data.subscription.status === 'ACTIVE') {
      html += '<span class="badge badge-yellow" style="background:rgba(232,184,75,0.15);color:var(--gold);">⭐ Premium</span>';
    }
    if (u.suspended) {
      html += '<span class="badge badge-red">⏸ Suspendu</span>';
    }
    html += '</div></div></div>';

    // Stats en grille
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;">';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center;"><div style="font-family:Syne,sans-serif;font-size:20px;font-weight:800;color:var(--orange);">' + rating + '</div><div style="font-size:11px;color:var(--muted);">Note ' + stars + '</div></div>';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center;"><div style="font-family:Syne,sans-serif;font-size:20px;font-weight:800;color:var(--green);">' + (data.completedMissionsCount || 0) + '</div><div style="font-size:11px;color:var(--muted);">Missions</div></div>';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center;"><div style="font-family:Syne,sans-serif;font-size:20px;font-weight:800;color:var(--blue);">' + (data.reviewCount || 0) + '</div><div style="font-size:11px;color:var(--muted);">Avis</div></div>';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center;"><div style="font-family:Syne,sans-serif;font-size:20px;font-weight:800;color:var(--white);">' + (data.yearsExperience || '—') + '</div><div style="font-size:11px;color:var(--muted);">Ans exp.</div></div>';
    html += '</div>';

    // Informations détaillées
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px;">';
    html += '<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Informations</h4>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">';
    html += '<div><span style="color:var(--muted);">ID :</span> <span style="color:var(--white);font-family:monospace;font-size:11px;">' + escHtml(data.id.substring(0, 8)) + '...</span></div>';
    html += '<div><span style="color:var(--muted);">Type :</span> <span style="color:var(--white);">' + escHtml(data.accountType === 'ENTREPRISE' ? 'Entreprise' : 'Indépendant') + '</span></div>';
    if (data.companyName) html += '<div><span style="color:var(--muted);">Société :</span> <span style="color:var(--white);">' + escHtml(data.companyName) + '</span></div>';
    if (data.siret) html += '<div><span style="color:var(--muted);">RCCM/SIRET :</span> <span style="color:var(--white);">' + escHtml(data.siret) + '</span></div>';
    html += '<div><span style="color:var(--muted);">Rayon :</span> <span style="color:var(--white);">' + (data.interventionRadiusKm || 30) + ' km</span></div>';
    html += '<div><span style="color:var(--muted);">Inscrit le :</span> <span style="color:var(--white);">' + formatDate(u.createdAt) + '</span></div>';
    if (data.hourlyRate) html += '<div><span style="color:var(--muted);">Tarif :</span> <span style="color:var(--orange);">' + formatNumber(data.hourlyRate) + ' FCFA/h</span></div>';
    html += '</div></div>';

    // Description
    if (data.description) {
      html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px;">';
      html += '<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Description</h4>';
      html += '<p style="font-size:13px;color:var(--light);line-height:1.6;">' + escHtml(data.description) + '</p>';
      html += '</div>';
    }

    // Score de confiance détaillé
    if (data.trustScore) {
      const ts = data.trustScore;
      const scoreColor = ts.total >= 70 ? 'var(--green)' : ts.total >= 40 ? 'var(--orange)' : 'var(--red)';
      html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
      html += '<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:0;">Score de confiance</h4>';
      html += '<span style="font-family:Syne,sans-serif;font-size:24px;font-weight:800;color:' + scoreColor + ';">' + ts.total + '<span style="font-size:14px;color:var(--muted);font-weight:400;">/100</span></span>';
      html += '</div>';
      html += '<div style="height:6px;background:var(--dark2);border-radius:3px;margin-bottom:14px;overflow:hidden;"><div style="height:100%;width:' + ts.total + '%;background:' + scoreColor + ';border-radius:3px;transition:width 0.5s;"></div></div>';
      // Bonus
      if (ts.bonus && ts.bonus.length > 0) {
        html += '<div style="margin-bottom:10px;"><div style="font-size:11px;color:var(--green);font-weight:600;margin-bottom:6px;">✓ BONUS</div>';
        ts.bonus.forEach(b => {
          html += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;"><span style="color:var(--light);">' + escHtml(b.label) + '</span><span style="color:var(--green);font-weight:600;">+' + b.points + '</span></div>';
        });
        html += '</div>';
      }
      // Pénalités
      if (ts.penalties && ts.penalties.length > 0) {
        html += '<div style="margin-bottom:10px;"><div style="font-size:11px;color:var(--red);font-weight:600;margin-bottom:6px;">✕ PÉNALITÉS</div>';
        ts.penalties.forEach(p => {
          html += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;"><span style="color:var(--light);">' + escHtml(p.label) + '</span><span style="color:var(--red);font-weight:600;">' + p.points + '</span></div>';
        });
        html += '</div>';
      }
      // Actions plainte
      html += '<div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">';
      html += '<button class="btn btn-reject" style="font-size:11px;padding:6px 12px;" onclick="addComplaint(\'' + data.id + '\')">⚠️ Ajouter plainte</button>';
      html += '<button class="btn btn-view" style="font-size:11px;padding:6px 12px;" onclick="removeComplaint(\'' + data.id + '\')">↩️ Retirer plainte</button>';
      html += '<span style="font-size:11px;color:var(--muted);align-self:center;margin-left:auto;">Plaintes : ' + (data.complaintsCount || 0) + '</span>';
      html += '</div></div>';
    }

    // Portfolio
    if (data.portfolio && data.portfolio.length > 0) {
      html += '<div style="margin-bottom:16px;">';
      html += '<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Portfolio (' + data.portfolio.length + ')</h4>';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
      data.portfolio.slice(0, 8).forEach(item => {
        html += '<img src="' + escHtml(item.imageUrl) + '" style="width:70px;height:70px;object-fit:cover;border-radius:10px;border:1px solid var(--border);cursor:pointer;" onclick="viewDocImage(\'' + escAttr(item.imageUrl) + '\',\'' + escAttr(item.caption || 'Portfolio') + '\')" onerror="this.style.display=\'none\'">';
      });
      html += '</div></div>';
    }

    // Derniers avis
    if (data.reviews && data.reviews.length > 0) {
      html += '<div style="margin-bottom:16px;">';
      html += '<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Derniers avis</h4>';
      data.reviews.slice(0, 3).forEach(r => {
        const authorName = r.author ? (r.author.firstName + ' ' + r.author.lastName) : 'Anonyme';
        html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:6px;">';
        html += '<div style="display:flex;justify-content:space-between;"><strong style="color:var(--white);font-size:12px;">' + escHtml(authorName) + '</strong><span style="color:var(--orange);font-size:12px;">' + '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) + '</span></div>';
        if (r.comment) html += '<p style="font-size:12px;color:var(--light);margin-top:4px;">' + escHtml(r.comment) + '</p>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Barre d'actions admin
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;padding:16px;background:var(--dark3);border:1px solid var(--border);border-radius:14px;margin-bottom:8px;">';
    html += '<span style="font-size:11px;color:var(--muted);align-self:center;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-right:4px;">Actions :</span>';
    if (u.suspended) {
      html += '<button class="btn btn-approve" onclick="reactivatePro(\'' + data.id + '\',\'' + escAttr(name) + '\')">↺ Réactiver</button>';
    } else {
      html += '<button class="btn btn-reject" onclick="suspendPro(\'' + data.id + '\',\'' + escAttr(name) + '\')">⏸ Suspendre</button>';
    }
    if (data.decennaleVerified) {
      html += '<span class="badge badge-green" style="align-self:center;font-size:11px;padding:6px 10px;">🛡️ Décennale validée</span>';
      html += '<button class="btn btn-secondary" style="font-size:11px;padding:6px 10px;" onclick="revokeDecennale(\'' + data.id + '\',\'' + escAttr(name) + '\')">↩ Révoquer décennale</button>';
    } else {
      html += '<button class="btn btn-approve" onclick="verifyDecennale(\'' + data.id + '\',\'' + escAttr(name) + '\')">🛡️ Valider décennale</button>';
    }
    html += '<button class="btn btn-view" onclick="resetProPassword(\'' + u.id + '\',\'' + escAttr(name) + '\',\'' + escAttr(data.id) + '\')">🔑 Reset MDP</button>';
    html += '<button class="btn btn-reject" onclick="closeModal(\'modal-project\');deleteProfessional(\'' + data.id + '\',\'' + escAttr(name) + '\')">🗑 Supprimer</button>';
    html += '</div>';

    document.getElementById('mp-title').textContent = 'Profil — ' + name;
    document.getElementById('mp-content').innerHTML = html;
    document.getElementById('modal-project').classList.add('show');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function verifyDecennale(proId, name) {
  if (!confirm('Valider l\'assurance décennale de ' + name + ' ?')) return;
  try {
    await apiCall('/admin/professionals/' + proId + '/verify-decennale', { method: 'PATCH' });
    showToast('Assurance décennale validée pour ' + name);
    viewProfessional(proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function revokeDecennale(proId, name) {
  if (!confirm('Révoquer la validation décennale de ' + name + ' ?')) return;
  try {
    await apiCall('/admin/professionals/' + proId + '/revoke-decennale', { method: 'PATCH' });
    showToast('Validation décennale révoquée pour ' + name);
    viewProfessional(proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function resetProPassword(userId, name, proId) {
  if (!confirm('Réinitialiser le mot de passe de ' + name + ' ?\nUn mot de passe temporaire sera généré.')) return;
  try {
    const res = await apiCall('/admin/users/' + userId + '/reset-password', { method: 'POST' });
    // Affiche dans une overlay sans écraser le profil
    showTempPasswordOverlay(res.temporaryPassword, name, userId, proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

function showTempPasswordOverlay(pwd, name, userId, proId) {
  const existing = document.getElementById('tmp-pwd-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tmp-pwd-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:18px;padding:28px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="font-size:36px;margin-bottom:12px;">🔑</div>
      <h3 style="font-size:17px;font-weight:700;color:var(--white);margin-bottom:6px;">Mot de passe réinitialisé</h3>
      <p style="font-size:13px;color:var(--muted);margin-bottom:20px;">${escHtml(name)}</p>
      <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:16px 20px;margin-bottom:16px;cursor:pointer;" onclick="navigator.clipboard.writeText('${escAttr(pwd)}');showToast('Mot de passe copié !')">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Mot de passe temporaire (cliquer pour copier)</div>
        <div style="font-family:monospace;font-size:24px;font-weight:800;color:var(--green);letter-spacing:3px;">${escHtml(pwd)}</div>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:20px;">Transmets ce mot de passe à l'utilisateur. Il devra le changer depuis l'application.</p>
      <button class="btn btn-view" style="width:100%;" onclick="document.getElementById('tmp-pwd-overlay').remove()">Fermer</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function addComplaint(proId) {
  if (!confirm('Confirmer l\'ajout d\'une plainte ? Cela réduira le score de confiance de -10 points.')) return;
  try {
    const res = await apiCall('/admin/professionals/' + proId + '/complaint', { method: 'POST' });
    showToast('Plainte enregistrée (total: ' + res.complaintsCount + ')');
    viewProfessional(proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function removeComplaint(proId) {
  if (!confirm('Retirer une plainte de ce professionnel ?')) return;
  try {
    const res = await apiCall('/admin/professionals/' + proId + '/complaint', { method: 'DELETE' });
    showToast('Plainte retirée (total: ' + res.complaintsCount + ')');
    viewProfessional(proId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// CLIENTS
// ══════════════════════════════════════════════════════════════
function debounceClients() {
  clearTimeout(clientsDebounceTimer);
  clientsDebounceTimer = setTimeout(() => loadClients(1), 400);
}

async function loadClients(page) {
  clientsCurrentPage = page;
  const search = document.getElementById('clients-search').value.trim();

  let url = '/admin/users?role=CLIENT&page=' + page + '&limit=15';
  if (search) url += '&search=' + encodeURIComponent(search);

  try {
    const data = await apiCall(url);
    const tbody = document.getElementById('clients-tbody');
    const emptyEl = document.getElementById('clients-empty');
    const paginationEl = document.getElementById('clients-pagination');

    if (!data.users || data.users.length === 0) {
      tbody.innerHTML = '';
      emptyEl.style.display = 'block';
      paginationEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    tbody.innerHTML = data.users.map(u => {
      const name = (u.firstName || '') + ' ' + (u.lastName || '');
      const suspended = u.suspended;
      const statusBadge = suspended
        ? '<span class="badge badge-red">Suspendu</span>'
        : '<span class="badge badge-green">Actif</span>';

      const actions = suspended
        ? '<button class="btn btn-approve" onclick="event.stopPropagation();reactivateUser(\'' + u.id + '\',\'' + escAttr(name) + '\')">↺ Réactiver</button>'
        : '<button class="btn btn-reject" onclick="event.stopPropagation();suspendUser(\'' + u.id + '\',\'' + escAttr(name) + '\')">⏸ Suspendre</button>';

      return '<tr style="cursor:pointer;" onclick="openClientModal(\'' + escAttr(u.id) + '\')">'
        + '<td><span style="font-family:monospace;font-size:11px;color:var(--orange);" title="' + escAttr(u.id) + '">' + escHtml(u.id.substring(0, 6)) + '</span></td>'
        + '<td><strong>' + escHtml(name) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + escHtml(u.email) + (u.phone ? ' · ' + escHtml(u.phone) : '') + '</span></td>'
        + '<td>' + escHtml(u.city || '-') + '</td>'
        + '<td>' + statusBadge + '</td>'
        + '<td>' + formatDate(u.createdAt) + '</td>'
        + '<td class="td-actions">'
          + actions
          + '<button class="btn btn-view" onclick="event.stopPropagation();openClientModal(\'' + escAttr(u.id) + '\')" title="Voir profil">👁</button>'
          + '<button class="btn btn-view" onclick="event.stopPropagation();resetClientPassword(\'' + u.id + '\',\'' + escAttr(name) + '\')" title="Reset mot de passe">🔑</button>'
          + '<button class="btn btn-reject" onclick="event.stopPropagation();deleteUser(\'' + u.id + '\',\'' + escAttr(name) + '\')" title="Supprimer">🗑</button>'
        + '</td></tr>';
    }).join('');

    // Pagination
    const pagination = data.pagination;
    if (pagination && pagination.totalPages > 1) {
      paginationEl.style.display = 'flex';
      document.getElementById('clients-page-info').textContent = 'Page ' + pagination.page + ' / ' + pagination.totalPages + ' (' + pagination.total + ' résultats)';
      document.getElementById('clients-prev').disabled = pagination.page <= 1;
      document.getElementById('clients-next').disabled = pagination.page >= pagination.totalPages;
    } else {
      paginationEl.style.display = 'none';
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
    }
  }
}

async function openClientModal(userId) {
  try {
    const u = await apiCall('/admin/users/' + userId);
    const name = ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
    document.getElementById('mc-title').textContent = name;

    const suspended = u.suspended;
    const stats = u._stats || {};

    // ── KPIs ──
    let html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;">';
    html += _kpiMini('Projets', u.projects ? u.projects.length : 0, '📋');
    html += _kpiMini('Devis reçus', stats.quoteCount || 0, '📄');
    html += _kpiMini('Dépensé', (stats.totalSpent || 0).toLocaleString('fr-FR') + ' FCFA', '💰');
    html += '</div>';

    // ── ONGLETS ──
    const tabId = 'client-tab-' + userId.substring(0, 6);
    html += '<div style="display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:10px;">';
    html += '<button id="' + tabId + '-infos" class="tab-btn tab-active" onclick="switchClientTab(\'' + tabId + '\',\'infos\')">Infos</button>';
    html += '<button id="' + tabId + '-projets" class="tab-btn" onclick="switchClientTab(\'' + tabId + '\',\'projets\')">Projets (' + (u.projects ? u.projects.length : 0) + ')</button>';
    html += '<button id="' + tabId + '-devis" class="tab-btn" onclick="switchClientTab(\'' + tabId + '\',\'devis\')">Devis (' + (stats.quoteCount || 0) + ')</button>';
    html += '<button id="' + tabId + '-avis" class="tab-btn" onclick="switchClientTab(\'' + tabId + '\',\'avis\')">Avis (' + (u.reviewsWritten ? u.reviewsWritten.length : 0) + ')</button>';
    html += '</div>';

    // ── TAB INFOS ──
    html += '<div id="' + tabId + '-tab-infos" class="client-tab-panel">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
    html += '<div style="background:var(--dark4);border:1px solid var(--border);border-radius:12px;padding:14px;">';
    html += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;font-weight:600;">CONTACT</div>';
    html += '<div style="font-weight:700;font-size:14px;margin-bottom:4px;">' + escHtml(name) + '</div>';
    html += '<div style="font-size:12px;color:var(--muted);">✉ ' + escHtml(u.email) + '</div>';
    if (u.phone) html += '<div style="font-size:12px;color:var(--muted);margin-top:3px;">📞 ' + escHtml(u.phone) + '</div>';
    if (u.city)  html += '<div style="font-size:12px;color:var(--muted);margin-top:3px;">📍 ' + escHtml(u.city) + '</div>';
    html += '</div>';
    html += '<div style="background:var(--dark4);border:1px solid var(--border);border-radius:12px;padding:14px;">';
    html += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;font-weight:600;">COMPTE</div>';
    html += '<div style="margin-bottom:6px;">' + (suspended ? '<span class="badge badge-red">Suspendu</span>' : '<span class="badge badge-green">Actif</span>') + '</div>';
    html += '<div style="font-size:12px;color:var(--muted);">Inscrit le ' + formatDate(u.createdAt) + '</div>';
    html += '<div style="font-size:12px;margin-top:3px;">Email : ' + (u.emailVerified ? '<span style="color:var(--green);">✓ vérifié</span>' : '<span style="color:var(--red);">✗ non vérifié</span>') + '</div>';
    html += '<div style="font-size:12px;margin-top:3px;">Tél : ' + (u.phoneVerified ? '<span style="color:var(--green);">✓ vérifié</span>' : '<span style="color:var(--muted);">non vérifié</span>') + '</div>';
    html += '</div></div>';
    html += '</div>';

    // ── TAB PROJETS ──
    html += '<div id="' + tabId + '-tab-projets" class="client-tab-panel" style="display:none;">';
    const projStatusColors = { OPEN:'var(--green)', IN_PROGRESS:'var(--blue)', COMPLETED:'var(--muted)', CANCELLED:'var(--red)' };
    const projStatusLabels = { OPEN:'Ouvert', IN_PROGRESS:'En cours', COMPLETED:'Terminé', CANCELLED:'Annulé' };
    if (u.projects && u.projects.length > 0) {
      html += '<div style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;">';
      u.projects.forEach(p => {
        const quoteCount = p.quotes ? p.quotes.length : 0;
        html += '<div style="background:var(--dark4);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
        html += '<div style="font-size:13px;font-weight:600;">' + escHtml(p.title || 'Sans titre') + '</div>';
        html += '<span style="font-size:11px;font-weight:600;color:' + (projStatusColors[p.status] || 'var(--muted)') + ';">' + (projStatusLabels[p.status] || p.status) + '</span>';
        html += '</div>';
        html += '<div style="font-size:11px;color:var(--muted);">' + formatDate(p.createdAt) + (quoteCount ? ' · ' + quoteCount + ' devis' : '') + '</div>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div style="text-align:center;padding:30px;color:var(--muted);font-size:13px;">Aucun projet publié</div>';
    }
    html += '</div>';

    // ── TAB DEVIS ──
    html += '<div id="' + tabId + '-tab-devis" class="client-tab-panel" style="display:none;">';
    const allQuotes = (u.projects || []).flatMap(p => (p.quotes || []).map(q => ({ ...q, projectTitle: p.title })));
    const quoteStatusColors = { PENDING:'var(--orange)', ACCEPTED:'var(--green)', REFUSED:'var(--red)', EXPIRED:'var(--muted)', REVISED:'var(--blue)' };
    const quoteStatusLabels = { PENDING:'En attente', ACCEPTED:'Accepté', REFUSED:'Refusé', EXPIRED:'Expiré', REVISED:'Révisé' };
    if (allQuotes.length > 0) {
      html += '<div style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;">';
      allQuotes.forEach(q => {
        const proName = q.professional ? ((q.professional.user.firstName || '') + ' ' + (q.professional.user.lastName || '')).trim() : '-';
        html += '<div style="background:var(--dark4);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
        html += '<div style="font-size:13px;font-weight:600;">' + escHtml(q.projectTitle || '-') + '</div>';
        html += '<span style="font-size:11px;font-weight:600;color:' + (quoteStatusColors[q.status] || 'var(--muted)') + ';">' + (quoteStatusLabels[q.status] || q.status) + '</span>';
        html += '</div>';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<div style="font-size:12px;color:var(--muted);">Par ' + escHtml(proName) + ' · ' + formatDate(q.createdAt) + '</div>';
        html += '<div style="font-size:13px;font-weight:700;color:var(--orange);">' + (q.amount || 0).toLocaleString('fr-FR') + ' FCFA</div>';
        html += '</div>';
        html += '<div style="margin-top:6px;"><a href="' + API_BASE + '/quotes/' + escAttr(q.id) + '/pdf?stream=1" target="_blank" class="btn btn-view" style="font-size:11px;padding:3px 10px;">📄 Voir PDF</a></div>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div style="text-align:center;padding:30px;color:var(--muted);font-size:13px;">Aucun devis reçu</div>';
    }
    html += '</div>';

    // ── TAB AVIS ──
    html += '<div id="' + tabId + '-tab-avis" class="client-tab-panel" style="display:none;">';
    if (u.reviewsWritten && u.reviewsWritten.length > 0) {
      html += '<div style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;">';
      u.reviewsWritten.forEach(r => {
        const proName = r.professional ? ((r.professional.user.firstName || '') + ' ' + (r.professional.user.lastName || '')).trim() : '-';
        const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
        html += '<div style="background:var(--dark4);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
        html += '<div style="font-size:13px;font-weight:600;">' + escHtml(proName) + '</div>';
        html += '<span style="color:var(--orange);font-size:13px;">' + stars + '</span>';
        html += '</div>';
        if (r.comment) html += '<div style="font-size:12px;color:var(--muted);font-style:italic;">"' + escHtml(r.comment) + '"</div>';
        html += '<div style="font-size:11px;color:var(--muted);margin-top:4px;">' + formatDate(r.createdAt) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div style="text-align:center;padding:30px;color:var(--muted);font-size:13px;">Aucun avis laissé</div>';
    }
    html += '</div>';

    // ── ACTIONS ──
    html += '<div style="display:flex;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">';
    if (suspended) {
      html += '<button class="btn btn-approve" style="flex:1;" onclick="reactivateUser(\'' + escAttr(u.id) + '\',\'' + escAttr(name) + '\');closeModal(\'modal-client\')">↺ Réactiver</button>';
    } else {
      html += '<button class="btn btn-reject" style="flex:1;" onclick="suspendUser(\'' + escAttr(u.id) + '\',\'' + escAttr(name) + '\');closeModal(\'modal-client\')">⏸ Suspendre</button>';
    }
    html += '<button class="btn btn-view" style="flex:1;" onclick="resetClientPassword(\'' + escAttr(u.id) + '\',\'' + escAttr(name) + '\')">🔑 Reset mdp</button>';
    html += '</div>';

    document.getElementById('mc-body').innerHTML = html;
    document.getElementById('modal-client').classList.add('show');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

function _kpiMini(label, value, icon) {
  return '<div style="background:var(--dark4);border:1px solid var(--border);border-radius:10px;padding:10px 12px;text-align:center;">'
    + '<div style="font-size:18px;margin-bottom:2px;">' + icon + '</div>'
    + '<div style="font-size:15px;font-weight:700;color:var(--white);">' + value + '</div>'
    + '<div style="font-size:10px;color:var(--muted);margin-top:2px;">' + label + '</div>'
    + '</div>';
}

function switchClientTab(tabId, tab) {
  ['infos','projets','devis','avis'].forEach(t => {
    const panel = document.getElementById(tabId + '-tab-' + t);
    const btn = document.getElementById(tabId + '-' + t);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
    if (btn) { btn.classList.toggle('tab-active', t === tab); }
  });
}

async function suspendUser(userId, name) {
  if (!confirm('Suspendre le compte de ' + name + ' ?')) return;
  try {
    await apiCall('/admin/users/' + userId + '/suspend', { method: 'PATCH' });
    showToast('Compte de ' + name + ' suspendu');
    loadClients(clientsCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function reactivateUser(userId, name) {
  try {
    await apiCall('/admin/users/' + userId + '/reactivate', { method: 'PATCH' });
    showToast('Compte de ' + name + ' réactivé');
    loadClients(clientsCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function deleteUser(userId, name) {
  if (!confirm('Supprimer définitivement ' + name + ' ? Cette action est irréversible.')) return;
  try {
    await apiCall('/admin/users/' + userId, { method: 'DELETE' });
    showToast('Compte de ' + name + ' supprimé');
    loadClients(clientsCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function resetClientPassword(userId, name) {
  if (!confirm('Réinitialiser le mot de passe de ' + name + ' ?')) return;
  try {
    const res = await apiCall('/admin/users/' + userId + '/reset-password', { method: 'POST' });
    showToast('Mot de passe temporaire : ' + res.temporaryPassword);
    // Afficher dans une alerte pour que l'admin puisse le copier
    alert('Mot de passe temporaire de ' + name + ' :\n\n' + res.temporaryPassword + '\n\nTransmets-le à l\'utilisateur.');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// PROJECTS
// ══════════════════════════════════════════════════════════════
async function loadProjects(page = 1) {
  try {
    // Charger les KPIs depuis le dashboard
    let data = dashboardData;
    if (!data) {
      data = await apiCall('/admin/dashboard');
      dashboardData = data;
    }
    document.getElementById('proj-open').textContent = data.projects.open;
    document.getElementById('proj-progress').textContent = data.projects.inProgress;
    document.getElementById('proj-completed').textContent = data.projects.completed;
    document.getElementById('proj-cancelled').textContent = data.projects.cancelled;

    // Charger la liste des projets
    const status = document.getElementById('proj-status-filter').value;
    const search = document.getElementById('proj-search').value;
    let url = '/admin/projects?page=' + page + '&limit=15';
    if (status) url += '&status=' + status;
    if (search) url += '&search=' + encodeURIComponent(search);

    const result = await apiCall(url);
    const tbody = document.getElementById('projects-tbody');
    const empty = document.getElementById('projects-empty');

    if (!result.projects || result.projects.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = result.projects.map(p => {
        const clientName = p.client ? escHtml(p.client.firstName + ' ' + p.client.lastName) : '-';
        const budget = p.budgetMin && p.budgetMax
          ? formatNumber(p.budgetMin) + ' – ' + formatNumber(p.budgetMax) + ' FCFA'
          : p.budgetMin ? formatNumber(p.budgetMin) + '+ FCFA'
          : p.budgetMax ? '≤ ' + formatNumber(p.budgetMax) + ' FCFA'
          : '-';
        const statusBadge = getProjectStatusBadge(p.status);
        const quotesCount = p.quotes ? p.quotes.length : 0;
        return '<tr onclick="viewProject(\'' + p.id + '\')" style="cursor:pointer;">' +
          '<td><span style="font-family:monospace;font-size:11px;color:var(--orange);cursor:pointer;" title="' + escAttr(p.id) + '" onclick="event.stopPropagation();navigator.clipboard.writeText(\'' + escAttr(p.id) + '\');showToast(\'ID copié\')">' + escHtml(p.id.substring(0, 6)) + '</span></td>' +
          '<td><strong>' + escHtml(p.title) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + escHtml(p.description || '').substring(0, 50) + (p.description && p.description.length > 50 ? '…' : '') + '</span></td>' +
          '<td>' + clientName + '</td>' +
          '<td>' + escHtml(p.tradeNeeded || '-') + '</td>' +
          '<td>' + escHtml(p.city || '-') + '</td>' +
          '<td style="color:var(--orange);font-weight:500;white-space:nowrap;">' + budget + '</td>' +
          '<td style="text-align:center;">' + quotesCount + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + formatDate(p.createdAt) + '</td>' +
          '<td class="td-actions">' +
            '<button class="btn btn-view" onclick="event.stopPropagation();viewProject(\'' + p.id + '\')" title="Voir détail">👁</button>' +
            '<button class="btn btn-reject" onclick="event.stopPropagation();deleteProject(\'' + p.id + '\',\'' + escAttr(p.title) + '\')" title="Supprimer">🗑</button>' +
          '</td></tr>';
      }).join('');
    }

    // Pagination
    const pag = document.getElementById('projects-pagination');
    if (result.totalPages > 1) {
      let pagHtml = '';
      if (page > 1) pagHtml += '<button class="btn btn-view" onclick="loadProjects(' + (page - 1) + ')">← Précédent</button>';
      pagHtml += '<span style="color:var(--muted);font-size:13px;padding:8px;">Page ' + page + ' / ' + result.totalPages + '</span>';
      if (page < result.totalPages) pagHtml += '<button class="btn btn-view" onclick="loadProjects(' + (page + 1) + ')">Suivant →</button>';
      pag.innerHTML = pagHtml;
    } else {
      pag.innerHTML = '';
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
    }
  }
}

async function viewProject(id) {
  try {
    const p = await apiCall('/admin/projects/' + id);
    const clientName = p.client ? escHtml(p.client.firstName + ' ' + p.client.lastName) : '-';
    const clientEmail = p.client ? escHtml(p.client.email || '') : '';
    const clientPhone = p.client ? escHtml(p.client.phone || '') : '';
    const budget = p.budgetMin && p.budgetMax
      ? formatNumber(p.budgetMin) + ' – ' + formatNumber(p.budgetMax) + ' FCFA'
      : p.budgetMin ? formatNumber(p.budgetMin) + '+ FCFA' : p.budgetMax ? '≤ ' + formatNumber(p.budgetMax) + ' FCFA' : 'Non défini';

    let html = '';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    html += '<span style="font-size:13px;color:var(--muted);">Statut</span>' + getProjectStatusBadge(p.status);
    html += '</div>';
    html += '<p style="font-size:14px;color:var(--light);line-height:1.6;">' + escHtml(p.description) + '</p>';
    html += '</div>';

    // Infos
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:14px;"><span style="font-size:11px;color:var(--muted);text-transform:uppercase;">Client</span><p style="color:var(--white);font-weight:600;margin-top:4px;">' + clientName + '</p><p style="font-size:12px;color:var(--muted);">' + clientEmail + (clientPhone ? ' · ' + clientPhone : '') + '</p></div>';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:14px;"><span style="font-size:11px;color:var(--muted);text-transform:uppercase;">Métier recherché</span><p style="color:var(--white);font-weight:600;margin-top:4px;">' + escHtml(p.tradeNeeded) + '</p></div>';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:14px;"><span style="font-size:11px;color:var(--muted);text-transform:uppercase;">Ville</span><p style="color:var(--white);font-weight:600;margin-top:4px;">' + escHtml(p.city) + '</p></div>';
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:14px;"><span style="font-size:11px;color:var(--muted);text-transform:uppercase;">Budget</span><p style="color:var(--orange);font-weight:600;margin-top:4px;">' + budget + '</p></div>';
    html += '</div>';

    // Photos
    if (p.photos && p.photos.length > 0) {
      html += '<div style="margin-bottom:16px;"><span style="font-size:12px;color:var(--muted);text-transform:uppercase;">Photos du projet</span>';
      html += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">';
      p.photos.forEach(ph => {
        html += '<img src="' + escHtml(ph.imageUrl) + '" style="width:80px;height:80px;object-fit:cover;border-radius:10px;border:1px solid var(--border);" onerror="this.style.display=\'none\'">';
      });
      html += '</div></div>';
    }

    // Devis
    if (p.quotes && p.quotes.length > 0) {
      html += '<div style="margin-bottom:16px;"><span style="font-size:12px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:8px;">Devis reçus (' + p.quotes.length + ')</span>';
      p.quotes.forEach(q => {
        const proName = q.professional && q.professional.user ? escHtml(q.professional.user.firstName + ' ' + q.professional.user.lastName) : '-';
        const qStatus = q.status === 'ACCEPTED' ? '<span class="badge badge-green">Accepté</span>'
          : q.status === 'REFUSED' ? '<span class="badge badge-red">Refusé</span>'
          : '<span class="badge badge-yellow">En attente</span>';
        html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">';
        html += '<div><strong style="color:var(--white);">' + proName + '</strong><p style="font-size:12px;color:var(--muted);margin-top:2px;">' + escHtml(q.description || '').substring(0, 80) + '</p><a href="' + API_BASE + '/quotes/' + escAttr(q.id) + '/pdf?stream=1" target="_blank" class="btn btn-view" style="font-size:11px;padding:3px 10px;margin-top:6px;display:inline-block;">📄 Voir PDF</a></div>';
        html += '<div style="text-align:right;"><span style="color:var(--orange);font-weight:700;font-size:15px;">' + formatNumber(q.amount) + ' FCFA</span><br>' + qStatus + '</div>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Aucun devis reçu pour le moment.</p>';
    }

    // Avis
    if (p.review) {
      html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;">';
      html += '<span style="font-size:11px;color:var(--muted);text-transform:uppercase;">Avis du client</span>';
      html += '<p style="color:var(--orange);font-size:16px;margin-top:6px;">' + '★'.repeat(p.review.rating) + '☆'.repeat(5 - p.review.rating) + '</p>';
      if (p.review.comment) html += '<p style="color:var(--light);font-size:13px;margin-top:6px;">"' + escHtml(p.review.comment) + '"</p>';
      html += '</div>';
    }

    // Barre d'actions admin
    const statuses = [
      { val: 'OPEN',        label: '● Ouvert',    cls: 'badge-green' },
      { val: 'IN_PROGRESS', label: '▶ En cours',  cls: 'badge-blue' },
      { val: 'COMPLETED',   label: '✓ Terminé',   cls: 'badge-orange' },
      { val: 'CANCELLED',   label: '✕ Annulé',    cls: 'badge-red' },
    ];
    html += '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:8px;">';
    html += '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:10px;">Changer le statut</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
    statuses.forEach(s => {
      const isCurrent = p.status === s.val;
      html += '<button class="btn ' + (isCurrent ? 'btn-approve' : 'btn-view') + '" style="' + (isCurrent ? 'opacity:0.5;cursor:default;' : '') + '" '
        + (isCurrent ? 'disabled' : 'onclick="changeProjectStatus(\'' + p.id + '\',\'' + s.val + '\')"') + '>'
        + s.label + '</button>';
    });
    html += '</div>';
    html += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">';
    html += '<button class="btn btn-reject" onclick="closeModal(\'modal-project\');deleteProject(\'' + p.id + '\',\'' + escAttr(p.title) + '\')">🗑 Supprimer ce projet</button>';
    html += '</div></div>';

    document.getElementById('mp-title').textContent = p.title;
    document.getElementById('mp-content').innerHTML = html;
    document.getElementById('modal-project').classList.add('show');
  } catch (err) {
    showToast('Erreur lors du chargement du projet');
  }
}

async function changeProjectStatus(projectId, status) {
  const labels = { OPEN: 'Ouvert', IN_PROGRESS: 'En cours', COMPLETED: 'Terminé', CANCELLED: 'Annulé' };
  if (!confirm('Changer le statut du projet en "' + labels[status] + '" ?')) return;
  try {
    await apiCall('/admin/projects/' + projectId, { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast('Statut mis à jour : ' + labels[status]);
    loadProjects(1);
    viewProject(projectId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function deleteProject(id, title) {
  if (!confirm('Supprimer le projet "' + title + '" ? Cette action est irréversible.')) return;
  try {
    await apiCall('/admin/projects/' + id, { method: 'DELETE' });
    showToast('🗑 Projet supprimé');
    loadProjects(1);
  } catch (err) {
    showToast('Erreur lors de la suppression');
  }
}

function getProjectStatusBadge(status) {
  switch (status) {
    case 'OPEN': return '<span class="badge badge-green">● Ouvert</span>';
    case 'IN_PROGRESS': return '<span class="badge badge-blue">▶ En cours</span>';
    case 'COMPLETED': return '<span class="badge badge-orange">✓ Terminé</span>';
    case 'CANCELLED': return '<span class="badge badge-red">✕ Annulé</span>';
    default: return '<span class="badge badge-muted">' + escHtml(status || '-') + '</span>';
  }
}

// ══════════════════════════════════════════════════════════════
// PAYMENTS
// ══════════════════════════════════════════════════════════════
async function loadPaymentStats() {
  try {
    const stats = await apiCall('/admin/payments/stats');
    document.getElementById('pay-revenue').textContent = formatCurrency(stats.totalRevenue);
    document.getElementById('pay-count').textContent = formatNumber(stats.totalSuccessfulPayments);
    document.getElementById('pay-failed').textContent = formatNumber(stats.failedPayments);

    // Graphique CA mensuel
    const revenueByMonth = stats.revenueByMonth || {};
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const shortLabel = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'][d.getMonth()];
      months.push({ key, label: shortLabel, val: revenueByMonth[key] || 0 });
    }
    const maxRev = Math.max(...months.map(m => m.val), 1);
    document.getElementById('pay-revenue-chart').innerHTML = months.map(m =>
      '<div class="bar-item" style="flex:1;">' +
        '<div style="font-size:9px;color:var(--green);font-weight:600;margin-bottom:2px;">' + (m.val > 0 ? formatCurrency(m.val) : '') + '</div>' +
        '<div style="width:100%;border-radius:6px 6px 0 0;background:' + (m.val > 0 ? 'linear-gradient(180deg,var(--green),rgba(34,197,94,0.3))' : 'rgba(255,255,255,0.04)') + ';height:' + Math.max(3, (m.val / maxRev) * 100) + '%;"></div>' +
      '</div>'
    ).join('');
    document.getElementById('pay-revenue-labels').innerHTML = months.map(m =>
      '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);">' + m.label + '</div>'
    ).join('');

    // Totaux acomptes vs soldes
    try {
      const [deposits, balances] = await Promise.all([
        apiCall('/admin/payments?status=succeeded&limit=1'),
        apiCall('/admin/payments?status=succeeded&limit=1'),
      ]);
      // Calcul depuis les paiements succeeded
      const allSucceeded = await apiCall('/admin/payments?status=succeeded&limit=100');
      let depTotal = 0, balTotal = 0;
      (allSucceeded.payments || []).forEach(p => {
        if (p.isDeposit === true) depTotal += p.amount;
        else if (p.isDeposit === false) balTotal += p.amount;
      });
      document.getElementById('pay-chart-deposit').textContent = formatCurrency(depTotal) + ' FCFA';
      document.getElementById('pay-chart-balance').textContent = formatCurrency(balTotal) + ' FCFA';
    } catch(e) {}

  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
    }
  }
}

async function loadPayments(page) {
  payCurrentPage = page;
  const status = document.getElementById('pay-status-filter').value;
  const search = document.getElementById('pay-search').value;
  const type = document.getElementById('pay-type-filter').value;

  let url = '/admin/payments?page=' + page + '&limit=15';
  if (status) url += '&status=' + encodeURIComponent(status);
  if (search) url += '&search=' + encodeURIComponent(search);
  if (type === 'deposit') url += '&isDeposit=true';
  else if (type === 'balance') url += '&isDeposit=false';

  try {
    const data = await apiCall(url);
    const tbody = document.getElementById('payments-tbody');
    const emptyEl = document.getElementById('payments-empty');
    const paginationEl = document.getElementById('payments-pagination');

    if (!data.payments || data.payments.length === 0) {
      tbody.innerHTML = '';
      emptyEl.style.display = 'block';
      paginationEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    tbody.innerHTML = data.payments.map(pay => {
      const statusBadge = getPaymentStatusBadge(pay.status);
      const typeBadge = pay.isDeposit
        ? '<span class="badge badge-orange">Acompte 30%</span>'
        : pay.isDeposit === false
          ? '<span class="badge badge-blue">Solde 70%</span>'
          : '<span class="badge badge-muted">-</span>';
      const proName = pay.quote && pay.quote.professional && pay.quote.professional.user
        ? (pay.quote.professional.user.firstName + ' ' + pay.quote.professional.user.lastName)
        : '-';
      const projectTitle = pay.quote && pay.quote.project ? pay.quote.project.title : '-';

      const disputeBtn = pay.status === 'succeeded'
        ? '<button class="btn btn-danger" onclick="openCreateDisputeModal(\'' + escAttr(pay.id) + '\',' + formatNumber(pay.amount) + ',\'' + escAttr(proName) + '\',\'' + escAttr(projectTitle) + '\')" title="Ouvrir un litige" style="padding:4px 8px;font-size:12px;">⚖️</button>'
        : '';
      return '<tr><td><span style="font-family:monospace;font-size:11px;color:var(--orange);cursor:pointer;" title="' + escAttr(pay.id) + '" onclick="event.stopPropagation();navigator.clipboard.writeText(\'' + escAttr(pay.id) + '\');showToast(\'ID copié\')">' + escHtml(pay.id.substring(0, 6)) + '</span></td><td style="color:var(--orange);font-weight:600">' + formatNumber(pay.amount) + ' FCFA</td><td>' + typeBadge + '</td><td>' + statusBadge + '</td><td>' + escHtml(proName) + '</td><td>' + escHtml(projectTitle) + '</td><td>' + formatDate(pay.createdAt) + '</td><td class="td-actions"><button class="btn btn-view" onclick="viewPaymentAuditLog(\'' + escAttr(pay.id) + '\')" title="Journal audit">📜</button>' + disputeBtn + '</td></tr>';
    }).join('');

    // Pagination
    const pagination = data.pagination;
    if (pagination && pagination.totalPages > 1) {
      paginationEl.style.display = 'flex';
      document.getElementById('pay-page-info').textContent = 'Page ' + pagination.page + ' / ' + pagination.totalPages + ' (' + pagination.total + ' résultats)';
      document.getElementById('pay-prev').disabled = pagination.page <= 1;
      document.getElementById('pay-next').disabled = pagination.page >= pagination.totalPages;
    } else {
      paginationEl.style.display = 'none';
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      void err;
    }
  }
}

// ══════════════════════════════════════════════════════════════
// MODÉRATION DE CONTENU
// ══════════════════════════════════════════════════════════════
let modCurrentPage = 1;
let currentReportId = null;

async function loadModerationStats() {
  try {
    const s = await apiCall('/admin/moderation/stats');
    document.getElementById('mod-pending').textContent = formatNumber(s.pending);
    document.getElementById('mod-total').textContent = formatNumber(s.total);
    document.getElementById('mod-removed').textContent = formatNumber(s.removed);
    document.getElementById('mod-dismissed').textContent = formatNumber(s.dismissed);
    // Badge nav
    if (s.pending > 0) {
      document.getElementById('badge-moderation').textContent = s.pending;
      document.getElementById('badge-moderation').style.display = '';
    } else {
      document.getElementById('badge-moderation').style.display = 'none';
    }
  } catch (_) {}
}

async function loadModeration(page = 1) {
  modCurrentPage = page;
  loadModerationStats();

  const status   = document.getElementById('mod-status-filter').value;
  const type     = document.getElementById('mod-type-filter').value;
  const dateFrom = document.getElementById('mod-date-from').value;
  const dateTo   = document.getElementById('mod-date-to').value;
  let url = '/admin/moderation/reports?page=' + page + '&limit=20';
  if (status)   url += '&status='      + status;
  if (type)     url += '&contentType=' + type;
  if (dateFrom) url += '&dateFrom='    + dateFrom;
  if (dateTo)   url += '&dateTo='      + dateTo;

  try {
    const data = await apiCall(url);
    const tbody  = document.getElementById('mod-tbody');
    const empty  = document.getElementById('mod-empty');
    const pag    = document.getElementById('mod-pagination');

    if (!data.reports || data.reports.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    const typeLabel = { REVIEW: '⭐ Avis', COMMENT: '💬 Commentaire', PORTFOLIO: '🖼️ Portfolio' };
    const statusBadge = {
      PENDING:   '<span class="badge" style="background:var(--red-dim);color:var(--red);">⏳ En attente</span>',
      DISMISSED: '<span class="badge" style="background:var(--green-dim);color:var(--green);">✅ Ignoré</span>',
      REMOVED:   '<span class="badge" style="background:rgba(107,114,128,0.15);color:var(--muted);">🗑️ Supprimé</span>',
    };

    tbody.innerHTML = data.reports.map(r => {
      const c = r.content;
      const excerpt = c ? escHtml((c.text || '').slice(0, 60) + ((c.text || '').length > 60 ? '…' : '')) : '<em style="color:var(--muted);">Contenu supprimé</em>';
      const authorInfo = c ? escHtml(c.authorName || '') : '—';
      const reporterName = escHtml((r.reporter.firstName || '') + ' ' + (r.reporter.lastName || ''));

      return '<tr>'
        + '<td>' + (typeLabel[r.contentType] || r.contentType) + '</td>'
        + '<td style="max-width:200px;">' + excerpt + '</td>'
        + '<td style="font-size:12px;">' + authorInfo + '</td>'
        + '<td style="font-size:12px;color:var(--orange);">' + escHtml(r.reason) + '</td>'
        + '<td style="font-size:12px;">' + reporterName + '</td>'
        + '<td style="font-size:12px;">' + formatDate(r.createdAt) + '</td>'
        + '<td>' + (statusBadge[r.status] || r.status) + '</td>'
        + '<td>'
          + (r.status === 'PENDING'
            ? '<button class="btn btn-view" onclick="openModerationModal(\'' + escAttr(r.id) + '\')" style="font-size:11px;padding:6px 10px;">👁 Voir</button>'
            : '<button class="btn btn-view" onclick="openModerationModal(\'' + escAttr(r.id) + '\')" style="font-size:11px;padding:6px 10px;">📋 Détail</button>')
        + '</td>'
        + '</tr>';
    }).join('');

    if (data.totalPages > 1) {
      pag.style.display = 'flex';
      document.getElementById('mod-prev').disabled = page <= 1;
      document.getElementById('mod-next').disabled = page >= data.totalPages;
      document.getElementById('mod-page-info').textContent = 'Page ' + page + ' / ' + data.totalPages + ' (' + data.total + ' signalements)';
    } else {
      pag.style.display = 'none';
    }
  } catch (err) {
    showToast('Erreur modération : ' + err.message, true);
  }
}

async function openModerationModal(reportId) {
  currentReportId = reportId;
  try {
    // Recharger les données fraîches
    const data = await apiCall('/admin/moderation/reports?limit=100&status=');
    const r = (data.reports || []).find(x => x.id === reportId);
    if (!r) { showToast('Signalement introuvable', true); return; }

    const c = r.content;
    const typeLabel = { REVIEW: '⭐ Avis', COMMENT: '💬 Commentaire', PORTFOLIO: '🖼️ Portfolio' };
    const statusBadge = {
      PENDING:   '<span class="badge" style="background:var(--red-dim);color:var(--red);">⏳ En attente</span>',
      DISMISSED: '<span class="badge" style="background:var(--green-dim);color:var(--green);">✅ Ignoré</span>',
      REMOVED:   '<span class="badge" style="background:rgba(107,114,128,0.15);color:var(--muted);">🗑️ Supprimé</span>',
    };

    let contentHtml = '';
    if (c) {
      contentHtml = '<div style="background:var(--dark4);border-radius:12px;padding:16px;margin-bottom:12px;">';
      if (r.contentType === 'REVIEW') {
        const stars = '★'.repeat(c.rating || 0) + '☆'.repeat(5 - (c.rating || 0));
        contentHtml += '<div style="font-size:18px;color:var(--yellow);margin-bottom:6px;">' + stars + '</div>';
      }
      contentHtml += '<p style="font-size:14px;color:var(--light);line-height:1.6;margin-bottom:8px;">' + escHtml(c.text || '(sans texte)') + '</p>';
      contentHtml += '<div style="font-size:12px;color:var(--muted);">Auteur : <strong style="color:var(--white);">' + escHtml(c.authorName || '?') + '</strong> · ' + escHtml(c.authorEmail || '') + '</div>';
      if (c.targetName) contentHtml += '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Sur le profil de : <strong style="color:var(--white);">' + escHtml(c.targetName) + '</strong></div>';
      contentHtml += '</div>';
    } else {
      contentHtml = '<div style="background:var(--dark4);border-radius:12px;padding:16px;margin-bottom:12px;color:var(--muted);font-size:13px;">⚠️ Contenu introuvable (peut-être déjà supprimé)</div>';
    }

    document.getElementById('mod-modal-body').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">'
      + '<div style="background:var(--dark4);border-radius:10px;padding:12px;">'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Type</div>'
      + '<div style="font-size:14px;font-weight:600;">' + (typeLabel[r.contentType] || r.contentType) + '</div>'
      + '</div>'
      + '<div style="background:var(--dark4);border-radius:10px;padding:12px;">'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Statut</div>'
      + (statusBadge[r.status] || r.status)
      + '</div>'
      + '</div>'
      + '<div style="margin-bottom:12px;">'
      + '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Raison du signalement</div>'
      + '<div style="font-size:14px;font-weight:600;color:var(--orange);">' + escHtml(r.reason) + '</div>'
      + (r.details ? '<div style="font-size:13px;color:var(--light);margin-top:4px;">' + escHtml(r.details) + '</div>' : '')
      + '</div>'
      + '<div style="margin-bottom:12px;">'
      + '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Signalé par</div>'
      + '<div style="font-size:14px;">' + escHtml((r.reporter.firstName || '') + ' ' + (r.reporter.lastName || '')) + '</div>'
      + '<div style="font-size:12px;color:var(--muted);">' + escHtml(r.reporter.email) + ' · ' + formatDate(r.createdAt) + '</div>'
      + '</div>'
      + '<div style="margin-bottom:4px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Contenu signalé</div>' + contentHtml + '</div>';

    // Cacher les boutons d'action si déjà traité
    document.getElementById('mod-dismiss-btn').style.display = r.status === 'PENDING' ? '' : 'none';
    document.getElementById('mod-remove-btn').style.display  = r.status === 'PENDING' ? '' : 'none';

    document.getElementById('modal-moderation').classList.add('show');
  } catch (err) {
    showToast('Erreur : ' + err.message, true);
  }
}

async function moderationAction(action) {
  if (!currentReportId) return;
  const label = action === 'remove' ? 'supprimer définitivement le contenu' : 'ignorer ce signalement';
  if (!confirm('Confirmer : ' + label + ' ?')) return;
  try {
    await apiCall('/admin/moderation/reports/' + currentReportId + '/' + action, { method: 'PATCH' });
    closeModal('modal-moderation');
    showToast(action === 'remove' ? '🗑️ Contenu supprimé' : '✅ Signalement ignoré');
    loadModeration(modCurrentPage);
  } catch (err) {
    showToast('Erreur : ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// ANALYTICS MÉTIER
// ══════════════════════════════════════════════════════════════
async function loadAnalytics() {
  try {
    const days = document.getElementById('ana-period')?.value || '365';
    const d = await apiCall('/admin/analytics?days=' + days);

    // ── Entonnoir ──────────────────────────────────────────
    const funnelSteps = [
      { label: 'Projets publiés',      val: d.funnel.totalProjects,    color: 'var(--blue)',   pct: 100 },
      { label: 'Projets avec devis',   val: d.funnel.projectsWithQuote, color: 'var(--orange)', pct: d.funnel.quoteRate },
      { label: 'Devis acceptés',       val: d.funnel.acceptedQuotes,   color: 'var(--yellow)', pct: d.funnel.acceptanceRate },
      { label: 'Projets payés',        val: d.funnel.paidProjects,     color: 'var(--green)',  pct: d.funnel.paymentRate },
    ];
    document.getElementById('ana-funnel').innerHTML = funnelSteps.map((s, i) => {
      const w = Math.max(30, s.pct);
      return '<div style="display:flex;align-items:center;gap:10px;">'
        + '<div style="width:' + w + '%;background:' + s.color + ';opacity:' + (1 - i * 0.15) + ';border-radius:8px;padding:10px 14px;transition:width .6s;min-width:120px;">'
        + '<span style="font-size:13px;font-weight:600;color:#fff;">' + formatNumber(s.val) + '</span>'
        + '</div>'
        + '<span style="font-size:12px;color:var(--muted);white-space:nowrap;">' + s.label + (i > 0 ? ' <span style="color:' + s.color + ';font-weight:700;">' + s.pct + '%</span>' : '') + '</span>'
        + '</div>';
    }).join('');

    // ── Donut devis ────────────────────────────────────────
    const q = d.quotes;
    const total = q.total || 1;
    const accPct = Math.round((q.accepted / total) * 100);
    const refPct = Math.round((q.refused / total) * 100);
    const pendPct = 100 - accPct - refPct;
    document.getElementById('ana-quote-donut').style.background =
      'conic-gradient(var(--green) 0% ' + accPct + '%, var(--red) ' + accPct + '% ' + (accPct + refPct) + '%, var(--yellow) ' + (accPct + refPct) + '% 100%)';
    document.getElementById('ana-quote-legend').innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;"><div style="width:10px;height:10px;border-radius:2px;background:var(--green)"></div>Acceptés (' + q.accepted + ')</div>' +
      '<div style="display:flex;align-items:center;gap:6px;"><div style="width:10px;height:10px;border-radius:2px;background:var(--red)"></div>Refusés (' + q.refused + ')</div>' +
      '<div style="display:flex;align-items:center;gap:6px;"><div style="width:10px;height:10px;border-radius:2px;background:var(--yellow)"></div>En attente (' + q.pending + ')</div>';
    document.getElementById('ana-quote-total').textContent = formatNumber(q.total);
    document.getElementById('ana-quote-rate').textContent = q.acceptanceRate + '%';

    // ── KPIs métriques ──────────────────────────────────────
    document.getElementById('ana-delay').textContent = d.avgDaysToFirstQuote + ' j';
    document.getElementById('ana-retention').textContent = d.retention.retentionRate + '%';
    document.getElementById('ana-retention-detail').textContent =
      d.retention.repeatClients + ' clients récurrents / ' + d.retention.clientsWithProjects + ' actifs';
    document.getElementById('ana-conversion').textContent = d.funnel.overallConversion + '%';
    document.getElementById('ana-top-city').textContent =
      d.cityStats.length > 0 ? escHtml(d.cityStats[0].city || '?') : '--';

    // ── Graphique croissance mensuelle ─────────────────────
    const growthEntries = Object.entries(d.growthByMonth || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const maxGrowth = Math.max(...growthEntries.map(([, v]) => v.clients + v.professionals), 1);
    const shortLabels = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    document.getElementById('ana-growth-chart').innerHTML = growthEntries.map(([key, v]) => {
      const proH = Math.max(2, (v.professionals / maxGrowth) * 80);
      const cliH = Math.max(2, (v.clients / maxGrowth) * 80);
      return '<div style="flex:1;display:flex;align-items:flex-end;gap:1px;" title="Pros: ' + v.professionals + ' / Clients: ' + v.clients + '">'
        + '<div style="flex:1;border-radius:3px 3px 0 0;background:var(--orange);height:' + proH + 'px;"></div>'
        + '<div style="flex:1;border-radius:3px 3px 0 0;background:var(--blue);height:' + cliH + 'px;"></div>'
        + '</div>';
    }).join('');
    document.getElementById('ana-growth-labels').innerHTML = growthEntries.map(([key]) => {
      const m = parseInt(key.split('-')[1]) - 1;
      return '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);">' + shortLabels[m] + '</div>';
    }).join('');

    // ── Top métiers (mini barres) ───────────────────────────
    const maxTrade = Math.max(...(d.tradeStats || []).map(t => t.projectCount), 1);
    document.getElementById('ana-trades').innerHTML = (d.tradeStats || []).slice(0, 8).map((t, i) => {
      const w = Math.max(8, (t.projectCount / maxTrade) * 100);
      const medals = ['🥇','🥈','🥉'];
      return '<div style="display:flex;align-items:center;gap:8px;">'
        + '<span style="font-size:13px;width:20px;text-align:center;">' + (medals[i] || (i + 1) + '.') + '</span>'
        + '<div style="flex:1;">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">'
        + '<span style="font-size:12px;font-weight:600;color:var(--white);">' + escHtml(t.trade || '-') + '</span>'
        + '<span style="font-size:11px;color:var(--muted);">' + t.projectCount + ' projets</span>'
        + '</div>'
        + '<div style="height:6px;background:var(--dark4);border-radius:3px;">'
        + '<div style="height:100%;width:' + w + '%;background:linear-gradient(90deg,var(--orange),var(--gold));border-radius:3px;transition:width .6s;"></div>'
        + '</div>'
        + '</div>'
        + '</div>';
    }).join('');

    // ── Top pros ───────────────────────────────────────────
    document.getElementById('ana-top-pros').innerHTML = (d.topPros || []).map((p, i) => {
      const medals = ['🥇','🥈','🥉'];
      return '<tr>'
        + '<td style="font-size:16px;">' + (medals[i] || (i + 1)) + '</td>'
        + '<td><strong>' + escHtml(p.name) + '</strong><br><span style="font-size:10px;color:var(--muted);">' + escHtml(p.email) + '</span></td>'
        + '<td style="font-size:12px;color:var(--muted);">' + escHtml(p.trade || '-') + '</td>'
        + '<td style="font-weight:600;color:var(--green);">' + formatCurrency(p.revenue) + ' FCFA</td>'
        + '<td style="color:var(--muted);font-size:12px;">' + p.paymentCount + '</td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">Aucune donnée</td></tr>';

    // ── Top villes ─────────────────────────────────────────
    const maxCity = Math.max(...(d.cityStats || []).map(c => c.count), 1);
    document.getElementById('ana-cities').innerHTML = (d.cityStats || []).map((c, i) => {
      const w = Math.max(8, (c.count / maxCity) * 100);
      return '<div style="display:flex;align-items:center;gap:8px;">'
        + '<span style="font-size:11px;color:var(--muted);width:16px;text-align:right;">' + (i + 1) + '</span>'
        + '<div style="flex:1;">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">'
        + '<span style="font-size:13px;font-weight:600;color:var(--white);">' + escHtml(c.city || '?') + '</span>'
        + '<span style="font-size:11px;color:var(--muted);">' + c.count + ' projets</span>'
        + '</div>'
        + '<div style="height:5px;background:var(--dark4);border-radius:3px;">'
        + '<div style="height:100%;width:' + w + '%;background:linear-gradient(90deg,var(--blue),rgba(59,130,246,0.4));border-radius:3px;transition:width .6s;"></div>'
        + '</div>'
        + '</div>'
        + '</div>';
    }).join('') || '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px;">Aucune ville enregistrée</div>';

    // ── Tableau détail métiers ──────────────────────────────
    const trades = d.tradeStats || [];
    if (trades.length === 0) {
      document.getElementById('ana-empty').style.display = 'block';
    } else {
      document.getElementById('ana-empty').style.display = 'none';
      document.getElementById('ana-trades-table').innerHTML = trades.map(t => {
        const avgRev = t.projectCount > 0 ? Math.round(t.revenue / t.projectCount) : 0;
        const rateColor = t.completionRate >= 70 ? 'var(--green)' : t.completionRate >= 40 ? 'var(--yellow)' : 'var(--red)';
        return '<tr>'
          + '<td><strong>' + escHtml(t.trade || '-') + '</strong></td>'
          + '<td>' + t.projectCount + '</td>'
          + '<td>' + t.completedCount + '</td>'
          + '<td><span style="color:' + rateColor + ';font-weight:600;">' + t.completionRate + '%</span></td>'
          + '<td style="font-weight:600;color:var(--green);">' + formatCurrency(t.revenue) + ' FCFA</td>'
          + '<td style="color:var(--muted);">' + formatCurrency(avgRev) + ' FCFA</td>'
          + '</tr>';
      }).join('');
    }

  } catch (err) {
    void err;
    showToast('Erreur chargement analytics : ' + err.message, true);
  }
}

async function exportAnalyticsCSV() {
  try {
    showToast('Export en cours…');
    const d = await apiCall('/admin/analytics');
    const headers = ['Métier', 'Projets', 'Terminés', 'Taux complétion (%)', 'CA total (FCFA)', 'CA moyen/projet (FCFA)'];
    const rows = (d.tradeStats || []).map(t => [
      t.trade || '',
      t.projectCount,
      t.completedCount,
      t.completionRate,
      Math.round(t.revenue),
      t.projectCount > 0 ? Math.round(t.revenue / t.projectCount) : 0,
    ]);
    if (rows.length === 0) { showToast('Aucune donnée à exporter', true); return; }
    const csv = [headers, ...rows].map(r =>
      r.map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')
    ).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'analytics_metiers_' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('Export téléchargé');
  } catch (err) {
    showToast('Erreur export : ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// FINANCES & REVENUS
// ══════════════════════════════════════════════════════════════
let finCurrentPage = 1;
let finDebounceTimer = null;
let finSummaryData = null;

function debounceFinSearch() {
  clearTimeout(finDebounceTimer);
  finDebounceTimer = setTimeout(() => loadFinancesCommissions(1), 350);
}

async function loadFinances() {
  try {
    const data = await apiCall('/admin/finances/summary');
    finSummaryData = data;

    document.getElementById('fin-total-transactions').textContent = formatCurrency(data.totalTransactions) + ' FCFA';
    document.getElementById('fin-total-commissions').textContent = formatCurrency(data.totalCommissions) + ' FCFA';
    document.getElementById('fin-commissions-dues').textContent = formatCurrency(data.commissionsDues) + ' FCFA';
    document.getElementById('fin-commissions-percues').textContent = formatCurrency(data.commissionsPercues) + ' FCFA';
    document.getElementById('fin-active-subs').textContent = formatNumber(data.activeSubscriptions);
    document.getElementById('fin-sub-revenue').textContent = formatCurrency(data.estimatedSubRevenue) + ' FCFA';
    document.getElementById('fin-commission-rate').textContent = (data.commissionRate * 100).toFixed(0) + '%';

    // Graphique barres double (transactions + commissions)
    const months = Object.entries(data.revenueByMonth || {});
    const maxVal = Math.max(...months.map(([,v]) => v.transactions), 1);
    const totalTx = months.reduce((s,[,v]) => s + v.transactions, 0);
    const totalCom = months.reduce((s,[,v]) => s + v.commissions, 0);
    document.getElementById('fin-chart-total').textContent =
      'CA : ' + formatCurrency(totalTx) + ' | Commissions : ' + formatCurrency(totalCom) + ' FCFA';

    const shortLabels = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

    document.getElementById('fin-bar-chart').innerHTML = months.map(([key, v]) => {
      const txH = Math.max(3, (v.transactions / maxVal) * 100);
      const comH = Math.max(2, (v.commissions / maxVal) * 100);
      return '<div style="flex:1;display:flex;align-items:flex-end;gap:1px;">'
        + '<div style="flex:1;border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--green),rgba(34,197,94,0.3));height:' + txH + '%;transition:height .5s;" title="' + formatCurrency(v.transactions) + ' FCFA"></div>'
        + '<div style="flex:1;border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--orange),rgba(244,114,11,0.3));height:' + comH + '%;transition:height .5s;" title="Commission : ' + formatCurrency(v.commissions) + ' FCFA"></div>'
        + '</div>';
    }).join('');

    document.getElementById('fin-bar-labels').innerHTML = months.map(([key]) => {
      const m = parseInt(key.split('-')[1]) - 1;
      return '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);">' + shortLabels[m] + '</div>';
    }).join('');

  } catch (err) {
    void err;
  }

  loadFinancesCommissions(1);
}

async function loadFinancesCommissions(page = 1) {
  finCurrentPage = page;
  const status = document.getElementById('fin-status-filter').value;
  const search = document.getElementById('fin-search').value.trim();

  let url = '/admin/finances/commissions?page=' + page + '&limit=20';
  if (status) url += '&status=' + status;
  if (search) url += '&search=' + encodeURIComponent(search);

  try {
    const data = await apiCall(url);
    const tbody = document.getElementById('fin-tbody');
    const empty = document.getElementById('fin-empty');
    const pagination = document.getElementById('fin-pagination');

    if (!data.professionals || data.professionals.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      pagination.style.display = 'none';
      return;
    }

    empty.style.display = 'none';

    tbody.innerHTML = data.professionals.map(pro => {
      const u = pro.user;
      const name = escHtml((u.firstName || '') + ' ' + (u.lastName || ''));
      const isDue = pro.commissionDue > 0;
      const statusBadge = isDue
        ? '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--red);">⏳ ' + formatCurrency(pro.commissionDue) + ' FCFA due</span>'
        : '<span class="badge" style="background:var(--green-dim);color:var(--green);">✅ Réglé</span>';

      const premiumBadge = pro.subscription && pro.subscription.status === 'ACTIVE'
        ? '<span class="badge badge-orange" style="font-size:10px;padding:2px 6px;margin-left:4px;">⭐ Premium</span>'
        : '';

      return '<tr>'
        + '<td><strong>' + name + '</strong>' + premiumBadge + '<br><span style="font-size:11px;color:var(--muted);">' + escHtml(u.email) + '</span></td>'
        + '<td>' + escHtml(pro.trade || '-') + '</td>'
        + '<td style="font-weight:600;">' + formatCurrency(pro.totalTransactions) + ' FCFA</td>'
        + '<td style="color:var(--orange);font-weight:600;">' + formatCurrency(pro.totalCommission) + ' FCFA</td>'
        + '<td style="color:var(--red);font-weight:600;">' + formatCurrency(pro.commissionDue) + ' FCFA</td>'
        + '<td style="color:var(--green);font-weight:600;">' + formatCurrency(pro.commissionPaid) + ' FCFA</td>'
        + '<td>' + statusBadge + '</td>'
        + '<td>'
          + (isDue ? '<button class="btn btn-approve" onclick="markCommissionPaid(\'' + escAttr(pro.professionalId) + '\',\'' + name + '\')" style="font-size:11px;padding:6px 10px;">✅ Marquer payé</button>' : '')
          + ' <button class="btn btn-view" onclick="viewFinanceDetail(\'' + escAttr(pro.professionalId) + '\')" style="font-size:11px;padding:6px 10px;">📋 Détail</button>'
        + '</td>'
        + '</tr>';
    }).join('');

    // Pagination
    if (data.totalPages > 1) {
      pagination.style.display = 'flex';
      document.getElementById('fin-prev').disabled = page <= 1;
      document.getElementById('fin-next').disabled = page >= data.totalPages;
      document.getElementById('fin-page-info').textContent = 'Page ' + page + ' / ' + data.totalPages + ' (' + data.total + ' professionnels)';
    } else {
      pagination.style.display = 'none';
    }
  } catch (err) {
    showToast('Erreur chargement commissions : ' + err.message, true);
  }
}

async function markCommissionPaid(professionalId, name) {
  if (!confirm('Marquer toutes les commissions dues de ' + name + ' comme payées ?')) return;
  try {
    const res = await apiCall('/admin/finances/commissions/' + professionalId + '/mark-paid', { method: 'PATCH' });
    showToast('✅ ' + res.count + ' paiement(s) marqué(s) — ' + formatCurrency(res.totalMarked) + ' FCFA perçus');
    loadFinances();
  } catch (err) {
    showToast('Erreur : ' + err.message, true);
  }
}

function viewFinanceDetail(professionalId) {
  if (!finSummaryData) return;
  // Naviguer vers la page commissions filtrée par ce pro n'est pas possible
  // On charge le détail depuis les données déjà en mémoire via un appel dédié
  apiCall('/admin/finances/commissions?search=&limit=100').then(data => {
    const pro = (data.professionals || []).find(p => p.professionalId === professionalId);
    if (!pro) { showToast('Données introuvables', true); return; }

    const u = pro.user;
    const rows = (pro.payments || []).map(p =>
      '<tr>'
      + '<td>' + escHtml(p.projectTitle || '-') + '</td>'
      + '<td>' + (p.isDeposit ? 'Acompte 30%' : 'Solde 70%') + '</td>'
      + '<td style="font-weight:600;">' + formatCurrency(p.amount) + ' FCFA</td>'
      + '<td style="color:var(--orange);">' + formatCurrency(p.commission) + ' FCFA</td>'
      + '<td>' + (p.commissionPaid
        ? '<span class="badge" style="background:var(--green-dim);color:var(--green);">Payé</span>'
        : '<span class="badge" style="background:var(--red-dim);color:var(--red);">Dû</span>') + '</td>'
      + '<td><button class="btn btn-view" onclick="toggleOneCommission(\'' + p.id + '\')" style="font-size:10px;padding:4px 8px;">'
        + (p.commissionPaid ? '↩ Annuler' : '✅ Marquer') + '</button></td>'
      + '<td>' + formatDate(p.completedAt || p.createdAt) + '</td>'
      + '</tr>'
    ).join('');

    const html = '<h2 style="margin-bottom:12px;">Détail commissions — ' + escHtml((u.firstName||'') + ' ' + (u.lastName||'')) + '</h2>'
      + '<p style="font-size:12px;color:var(--muted);margin-bottom:16px;">' + escHtml(u.email) + ' · ' + escHtml(pro.trade||'') + '</p>'
      + '<table><thead><tr><th>Projet</th><th>Type</th><th>Montant</th><th>Commission</th><th>Statut</th><th>Action</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table>';

    document.getElementById('fin-detail-body').innerHTML = html;
    document.getElementById('modal-fin-detail').classList.add('show');
  }).catch(err => showToast('Erreur : ' + err.message, true));
}

async function toggleOneCommission(paymentId) {
  try {
    const res = await apiCall('/admin/finances/payments/' + paymentId + '/mark-paid', { method: 'PATCH' });
    showToast(res.commissionPaid ? '✅ Commission marquée payée' : '↩ Commission remise en "due"');
    // Recharger le détail en restant sur la modale
    closeModal('modal-fin-detail');
    loadFinances();
  } catch (err) {
    showToast('Erreur : ' + err.message, true);
  }
}

async function exportFinancesCSV() {
  try {
    showToast('Export en cours…');

    // Respecter les filtres actifs dans la page
    const status   = document.getElementById('fin-status-filter')?.value || '';
    const search   = document.getElementById('fin-search')?.value.trim() || '';
    const params   = new URLSearchParams({ limit: 5000 });
    if (status) params.set('status', status);
    if (search) params.set('search', search);

    const data = await apiCall('/admin/finances/commissions?' + params);
    const pros = data.professionals || [];

    if (pros.length === 0) { showToast('Aucune donnée à exporter', true); return; }

    const headers = [
      'Professionnel', 'Email', 'Ville', 'Métier', 'Premium',
      'Nb transactions', 'CA Total (FCFA)',
      'Commission Totale (FCFA)', 'Commission Due (FCFA)', 'Commission Perçue (FCFA)',
      'Statut', 'Dernier paiement',
    ];

    const rows = pros.map(pro => {
      const u = pro.user;
      const lastPayment = pro.payments && pro.payments.length
        ? new Date(pro.payments[0].createdAt).toLocaleDateString('fr-FR') : '';
      return [
        (u.firstName || '') + ' ' + (u.lastName || ''),
        u.email,
        u.city || '',
        pro.trade || '',
        pro.subscription && pro.subscription.status === 'ACTIVE' ? 'Oui' : 'Non',
        pro.payments ? pro.payments.length : 0,
        pro.totalTransactions,
        Math.round(pro.totalCommission),
        Math.round(pro.commissionDue),
        Math.round(pro.commissionPaid),
        pro.commissionDue > 0 ? 'Dû' : 'Réglé',
        lastPayment,
      ];
    });

    const filterLabel = status === 'due' ? '_dues' : status === 'paid' ? '_reglees' : '';
    const filename = 'commissions' + filterLabel + '_' + new Date().toISOString().slice(0, 10) + '.csv';

    const csv = [headers, ...rows].map(r =>
      r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')
    ).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('Export téléchargé — ' + rows.length + ' lignes');
  } catch (err) {
    showToast('Erreur export : ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// JOURNAL D'AUDIT
// ══════════════════════════════════════════════════════════════
async function loadAuditLogs(page = 1) {
  auditCurrentPage = page;
  const triggeredBy = document.getElementById('audit-trigger-filter').value;
  const reason = document.getElementById('audit-reason-filter').value;

  let url = '/admin/audit-logs?page=' + page + '&limit=30';
  if (triggeredBy) url += '&triggeredBy=' + encodeURIComponent(triggeredBy);
  if (reason) url += '&reason=' + encodeURIComponent(reason);

  try {
    const data = await apiCall(url);
    const tbody = document.getElementById('audit-tbody');
    const emptyEl = document.getElementById('audit-empty');
    const paginationEl = document.getElementById('audit-pagination');

    // KPIs
    document.getElementById('audit-total').textContent = formatNumber(data.pagination.total);
    const succeeded = (data.logs || []).filter(l => l.toStatus === 'succeeded').length;
    const mismatches = (data.logs || []).filter(l => l.reason === 'amount_mismatch').length;
    document.getElementById('audit-succeeded').textContent = succeeded;
    document.getElementById('audit-mismatches').textContent = mismatches;

    if (!data.logs || data.logs.length === 0) {
      tbody.innerHTML = '';
      emptyEl.style.display = 'block';
      paginationEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    tbody.innerHTML = data.logs.map(log => {
      const pay = log.payment;
      const projectTitle = pay && pay.quote && pay.quote.project ? escHtml(pay.quote.project.title) : '-';
      const proName = pay && pay.quote && pay.quote.professional && pay.quote.professional.user
        ? escHtml(pay.quote.professional.user.firstName + ' ' + pay.quote.professional.user.lastName)
        : '-';
      const typeBadge = pay
        ? (pay.isDeposit ? '<span class="badge badge-orange" style="font-size:10px;">Acompte</span>' : '<span class="badge badge-blue" style="font-size:10px;">Solde</span>')
        : '-';
      const amount = pay ? formatNumber(pay.amount) + ' FCFA' : '-';
      const fromBadge = getPaymentStatusBadge(log.fromStatus);
      const toBadge = getPaymentStatusBadge(log.toStatus);
      const triggerBadge = log.triggeredBy === 'webhook' ? '<span class="badge badge-blue" style="font-size:10px;">webhook</span>'
        : log.triggeredBy === 'cron_expiry' || log.triggeredBy === 'cron' ? '<span class="badge badge-yellow" style="font-size:10px;">cron</span>'
        : log.triggeredBy === 'reconciliation' ? '<span class="badge badge-muted" style="font-size:10px;">réconcil.</span>'
        : '<span class="badge badge-muted" style="font-size:10px;">' + escHtml(log.triggeredBy || 'système') + '</span>';
      const reasonText = log.reason ? escHtml(log.reason.replace(/_/g, ' ')) : '-';
      const payId = pay ? '<span style="font-family:monospace;font-size:11px;color:var(--orange);cursor:pointer;" onclick="navigator.clipboard.writeText(\'' + escAttr(pay.id) + '\');showToast(\'ID copié\')" title="' + escAttr(pay.id) + '">' + escHtml(pay.id.substring(0, 6)) + '</span>' : '-';
      return '<tr>'
        + '<td style="white-space:nowrap;font-size:12px;">' + formatDate(log.createdAt) + '</td>'
        + '<td>' + payId + '</td>'
        + '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + projectTitle + '<br><span style="font-size:11px;color:var(--muted);">' + proName + '</span></td>'
        + '<td>' + typeBadge + '</td>'
        + '<td style="color:var(--orange);font-weight:600;white-space:nowrap;">' + amount + '</td>'
        + '<td style="white-space:nowrap;">' + fromBadge + ' → ' + toBadge + '</td>'
        + '<td style="font-size:12px;color:var(--muted);">' + reasonText + '</td>'
        + '<td>' + triggerBadge + '</td>'
        + '</tr>';
    }).join('');

    const pagination = data.pagination;
    if (pagination && pagination.totalPages > 1) {
      paginationEl.style.display = 'flex';
      document.getElementById('audit-page-info').textContent = 'Page ' + pagination.page + ' / ' + pagination.totalPages + ' (' + pagination.total + ' entrées)';
      document.getElementById('audit-prev').disabled = pagination.page <= 1;
      document.getElementById('audit-next').disabled = pagination.page >= pagination.totalPages;
    } else {
      paginationEl.style.display = 'none';
    }
  } catch (err) {
    void err;
  }
}

async function viewPaymentAuditLog(paymentId) {
  try {
    const data = await apiCall('/admin/payments/' + paymentId + '/audit-logs');
    const pay = data.payment;
    const logs = data.logs || [];

    // ── En-tête paiement ──
    const proName = pay?.quote?.professional?.user
      ? escHtml(pay.quote.professional.user.firstName + ' ' + pay.quote.professional.user.lastName)
      : '—';
    const projectTitle = pay?.quote?.project?.title ? escHtml(pay.quote.project.title) : '—';
    const typeBadge = pay ? (pay.isDeposit
      ? '<span class="badge badge-orange">Acompte</span>'
      : '<span class="badge badge-blue">Solde</span>') : '';
    const statusBadge = pay ? getPaymentStatusBadge(pay.status) : '';

    let html = '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">';
    html += '<div>';
    html += '<div style="font-size:18px;font-weight:700;color:var(--orange);margin-bottom:4px;">' + (pay ? formatNumber(pay.amount) + ' FCFA' : '—') + '</div>';
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">📁 ' + projectTitle + ' &nbsp;·&nbsp; 👷 ' + proName + '</div>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + typeBadge + ' ' + statusBadge + '</div>';
    html += '</div>';
    html += '<div style="text-align:right;font-size:11px;color:var(--muted);">';
    if (pay?.geniuspayRef) html += '<div style="font-family:monospace;background:var(--dark4);padding:3px 8px;border-radius:6px;margin-bottom:4px;cursor:pointer;" onclick="navigator.clipboard.writeText(\'' + escAttr(pay.geniuspayRef) + '\');showToast(\'Réf. copiée\')" title="Copier la référence GeniusPay">🔗 ' + escHtml(pay.geniuspayRef.substring(0, 16)) + '…</div>';
    if (pay?.createdAt) html += '<div>Créé le ' + formatDate(pay.createdAt) + '</div>';
    if (pay?.completedAt) html += '<div style="color:var(--green);">Complété le ' + formatDate(pay.completedAt) + '</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    // ── Timeline ──
    if (logs.length === 0) {
      html += '<div style="text-align:center;padding:30px;color:var(--muted);font-size:13px;">Aucune entrée dans le journal pour ce paiement.</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">' + logs.length + ' événement' + (logs.length > 1 ? 's' : '') + '</div>';
      html += '<div style="position:relative;padding-left:24px;max-height:380px;overflow-y:auto;">';
      html += '<div style="position:absolute;left:8px;top:0;bottom:0;width:2px;background:var(--border);border-radius:2px;"></div>';
      logs.forEach((log, i) => {
        const isLast = i === logs.length - 1;
        const fromBadge = getPaymentStatusBadge(log.fromStatus);
        const toBadge = getPaymentStatusBadge(log.toStatus);
        const isAnomaly = log.reason === 'amount_mismatch';
        const isSuccess = log.toStatus === 'succeeded';
        const dotColor = isAnomaly ? 'var(--red)' : isSuccess ? 'var(--green)' : 'var(--orange)';

        // Déclencheur badge
        const trigMap = { webhook: ['badge-blue','webhook'], cron_expiry: ['badge-yellow','cron'], cron: ['badge-yellow','cron'], reconciliation: ['badge-muted','réconcil.'], manual: ['badge-muted','manuel'], system: ['badge-muted','système'] };
        const trig = trigMap[log.triggeredBy] || ['badge-muted', escHtml(log.triggeredBy || 'système')];
        const trigBadge = '<span class="badge ' + trig[0] + '" style="font-size:10px;">' + trig[1] + '</span>';

        // Metadata
        let metaHtml = '';
        if (log.metadata) {
          try {
            const meta = JSON.parse(log.metadata);
            if (meta.expected !== undefined) {
              metaHtml += '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:8px;margin-top:8px;font-size:11px;">';
              metaHtml += '⚠️ <strong style="color:var(--red);">Anomalie de montant</strong><br>';
              metaHtml += '<span style="color:var(--muted);">Attendu :</span> <strong>' + formatNumber(meta.expected) + ' FCFA</strong> &nbsp;·&nbsp; ';
              metaHtml += '<span style="color:var(--muted);">Reçu :</span> <strong style="color:var(--red);">' + formatNumber(meta.received) + ' FCFA</strong><br>';
              metaHtml += '<span style="color:var(--muted);">Écart :</span> <strong style="color:var(--red);">' + formatNumber(Math.abs(meta.received - meta.expected)) + ' FCFA</strong>';
              metaHtml += '</div>';
            } else if (Object.keys(meta).length > 0) {
              metaHtml += '<div style="font-size:11px;color:var(--muted);margin-top:6px;font-family:monospace;background:var(--dark4);padding:6px 8px;border-radius:6px;">' + escHtml(JSON.stringify(meta, null, 2)) + '</div>';
            }
          } catch(e) {}
        }

        html += '<div style="position:relative;margin-bottom:' + (isLast ? '4' : '16') + 'px;">';
        html += '<div style="position:absolute;left:-20px;top:4px;width:10px;height:10px;border-radius:50%;background:' + dotColor + ';border:2px solid var(--dark2);"></div>';
        html += '<div style="background:var(--dark4);border:1px solid ' + (isAnomaly ? 'rgba(239,68,68,0.4)' : 'var(--border)') + ';border-radius:12px;padding:10px 12px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:4px;">';
        html += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' + fromBadge + '<span style="color:var(--muted);font-size:13px;">→</span>' + toBadge + ' ' + trigBadge + '</div>';
        html += '<span style="font-size:11px;color:var(--muted);white-space:nowrap;">' + formatDate(log.createdAt) + '</span>';
        html += '</div>';
        if (log.reason) html += '<div style="font-size:12px;color:var(--light);">📌 ' + escHtml(log.reason.replace(/_/g, ' ')) + '</div>';
        html += metaHtml;
        html += '</div></div>';
      });
      html += '</div>';
    }

    document.getElementById('mp-title').textContent = '📜 Journal d\'audit — ' + (pay ? formatNumber(pay.amount) + ' FCFA · ' + projectTitle : paymentId.substring(0, 8));
    document.getElementById('mp-content').innerHTML = html;
    document.getElementById('modal-project').classList.add('show');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// CRÉER LITIGE (depuis paiements)
// ══════════════════════════════════════════════════════════════
let _cDisPaymentId = null;

function openCreateDisputeModal(paymentId, amount, proName, projectTitle) {
  _cDisPaymentId = paymentId;
  document.getElementById('cdis-pay-info').textContent =
    formatNumber(amount) + ' FCFA — ' + proName + ' — ' + projectTitle;
  document.getElementById('cdis-reason').value = 'WORK_NOT_DONE';
  document.getElementById('cdis-description').value = '';
  document.getElementById('modal-create-dispute').classList.add('show');
}

async function submitCreateDispute() {
  if (!_cDisPaymentId) return;
  const reason      = document.getElementById('cdis-reason').value;
  const description = document.getElementById('cdis-description').value.trim();
  try {
    await apiCall('/admin/disputes', {
      method: 'POST',
      body: JSON.stringify({ paymentId: _cDisPaymentId, reason, description: description || undefined }),
    });
    closeModal('modal-create-dispute');
    showToast('Litige ouvert avec succès');
    // Rafraîchir la page litiges si elle est active
    if (currentPage === 'disputes') { loadDisputeStats(); loadDisputes(1); }
  } catch (err) {
    showToast('Erreur : ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// COMPTES SUPPRIMÉS
// ══════════════════════════════════════════════════════════════
async function loadDeletedUsers(page = 1) {
  try {
    const search = document.getElementById('deleted-search').value;
    let url = '/admin/users-deleted?page=' + page + '&limit=15';
    if (search) url += '&search=' + encodeURIComponent(search);

    const result = await apiCall(url);
    const tbody = document.getElementById('deleted-tbody');
    const empty = document.getElementById('deleted-empty');

    // KPIs — calculés sur la première page sans filtre de recherche
    if (page === 1 && !search) {
      const allResult = await apiCall('/admin/users-deleted?page=1&limit=5000');
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const restorable = (allResult.users || []).filter(u => new Date(u.deletedAt).getTime() > thirtyDaysAgo).length;
      const old = (allResult.total || 0) - restorable;
      document.getElementById('del-kpi-total').textContent   = formatNumber(allResult.total || 0);
      document.getElementById('del-kpi-restore').textContent = formatNumber(restorable);
      document.getElementById('del-kpi-old').textContent     = formatNumber(old);
    }

    if (!result.users || result.users.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = result.users.map(u => {
        const roleBadge = u.role === 'PROFESSIONAL' ? '<span style="color:var(--orange)">Pro</span>' : '<span style="color:var(--blue)">Client</span>';
        return '<tr>' +
          '<td><span style="font-family:monospace;font-size:11px;color:var(--orange);cursor:pointer;" title="' + escAttr(u.id) + '" onclick="navigator.clipboard.writeText(\'' + escAttr(u.id) + '\');showToast(\'ID copié\')">' + escHtml(u.id.substring(0, 6)) + '</span></td>' +
          '<td><strong>' + escHtml(u.firstName + ' ' + u.lastName) + '</strong></td>' +
          '<td>' + escHtml(u.email) + '</td>' +
          '<td>' + roleBadge + '</td>' +
          '<td>' + escHtml(u.city || '-') + '</td>' +
          '<td>' + formatDate(u.deletedAt) + '</td>' +
          '<td>' + formatDate(u.createdAt) + '</td>' +
          '<td class="td-actions">' +
            '<button class="btn btn-approve" onclick="restoreUser(\'' + u.id + '\',\'' + escAttr(u.firstName + ' ' + u.lastName) + '\')" title="Réactiver">♻️ Réactiver</button>' +
            '<button class="btn btn-reject" onclick="purgeUser(\'' + u.id + '\',\'' + escAttr(u.firstName + ' ' + u.lastName) + '\')" title="Supprimer définitivement" style="margin-left:4px;">🗑 Purger</button>' +
          '</td></tr>';
      }).join('');
    }

    // Pagination
    const pag = document.getElementById('deleted-pagination');
    if (result.totalPages > 1) {
      let pagHtml = '';
      if (page > 1) pagHtml += '<button class="btn btn-view" onclick="loadDeletedUsers(' + (page - 1) + ')">← Précédent</button>';
      pagHtml += '<span style="color:var(--muted);font-size:13px;padding:8px;">Page ' + page + ' / ' + result.totalPages + ' (' + result.total + ' comptes)</span>';
      if (page < result.totalPages) pagHtml += '<button class="btn btn-view" onclick="loadDeletedUsers(' + (page + 1) + ')">Suivant →</button>';
      pag.innerHTML = pagHtml;
    } else {
      pag.innerHTML = '';
    }
  } catch (err) {
    void err;
  }
}

async function restoreUser(id, name) {
  if (!confirm('Réactiver le compte de ' + name + ' ?')) return;
  try {
    await apiCall('/admin/users/' + id + '/restore', { method: 'PATCH' });
    showToast('Compte réactivé');
    loadDeletedUsers(1);
  } catch (err) {
    alert('Erreur: ' + (err.message || 'Impossible de réactiver'));
  }
}

async function purgeUser(id, name) {
  if (!confirm('⚠️ ATTENTION : Supprimer DÉFINITIVEMENT le compte de ' + name + ' ?\n\nCette action est IRRÉVERSIBLE. Toutes les données seront perdues.')) return;
  if (!confirm('Dernière confirmation : êtes-vous sûr de vouloir purger ce compte ?')) return;
  try {
    await apiCall('/admin/users/' + id + '/purge', { method: 'DELETE' });
    showToast('Compte définitivement supprimé');
    loadDeletedUsers(1);
  } catch (err) {
    alert('Erreur: ' + (err.message || 'Impossible de supprimer'));
  }
}

// ══════════════════════════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════════════════════════
function viewDocImage(url, title) {
  document.getElementById('modal-doc-title').textContent = title;
  const img = document.getElementById('modal-doc-img');
  const placeholder = document.getElementById('modal-doc-placeholder');
  if (url) {
    img.src = url;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    img.style.display = 'none';
    placeholder.style.display = 'block';
  }
  document.getElementById('modal-doc').classList.add('show');
}

function openRejectModal(name, proId) {
  document.getElementById('reject-name').textContent = name;
  currentRejectProId = proId;
  document.getElementById('modal-reject').classList.add('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// Click outside modal to close
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
});

// ══════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  document.getElementById('toast-msg').textContent = msg;
  icon.textContent = isError ? '⚠️' : '✅';
  t.style.borderColor = isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function formatNumber(n) {
  if (n === null || n === undefined) return '--';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '--';
  if (amount >= 1000000) return (amount / 1000000).toFixed(1) + 'M';
  if (amount >= 1000) return (amount / 1000).toFixed(0) + 'k';
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return "Aujourd'hui, " + d.getHours().toString().padStart(2, '0') + 'h' + d.getMinutes().toString().padStart(2, '0');
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) {
    return 'Hier, ' + d.getHours().toString().padStart(2, '0') + 'h' + d.getMinutes().toString().padStart(2, '0');
  }
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function getStatusBadge(status) {
  switch (status) {
    case 'APPROVED': return '<span class="badge badge-green">✓ Vérifié</span>';
    case 'PENDING': return '<span class="badge badge-yellow">⏳ En attente</span>';
    case 'REJECTED': return '<span class="badge badge-red">✕ Rejeté</span>';
    case 'NOT_SUBMITTED': return '<span class="badge badge-muted">Non soumis</span>';
    default: return '<span class="badge badge-muted">' + escHtml(status || '-') + '</span>';
  }
}

function getPaymentStatusBadge(status) {
  switch (status) {
    case 'succeeded': return '<span class="badge badge-green">✓ Succès</span>';
    case 'pending': return '<span class="badge badge-yellow">⏳ En attente</span>';
    case 'failed': return '<span class="badge badge-red">✕ Échoué</span>';
    default: return '<span class="badge badge-muted">' + escHtml(status || '-') + '</span>';
  }
}

function getTradeEmoji(trade) {
  if (!trade) return '👷';
  const t = trade.toLowerCase();
  if (t.includes('maçon') || t.includes('macon')) return '🧱';
  if (t.includes('électricien') || t.includes('electricien')) return '⚡';
  if (t.includes('plombier')) return '🔧';
  if (t.includes('peintre')) return '🎨';
  if (t.includes('carreleur')) return '🔲';
  if (t.includes('menuisier')) return '🪚';
  return '👷';
}

// ══════════════════════════════════════════════════════════════
// SÉCURITÉ & CONFORMITÉ
// ══════════════════════════════════════════════════════════════

let secDebounceTimer = null;

async function loadSecurity() {
  await Promise.all([loadSecurityStats(), loadSecurityAlerts(), loadSuspended(1), loadSecurityActivity()]);
}

async function loadSecurityStats() {
  try {
    const s = await apiCall('/admin/security/stats');
    document.getElementById('sec-suspended').textContent    = formatNumber(s.suspendedCount);
    document.getElementById('sec-resets').textContent       = formatNumber(s.resetActive);
    document.getElementById('sec-unverified').textContent   = formatNumber(s.emailUnverified);
    document.getElementById('sec-archived').textContent     = formatNumber(s.archivedCount);
    document.getElementById('sec-stale-resets').textContent = formatNumber(s.resetStale);
    document.getElementById('sec-otp-orphans').textContent  = formatNumber(s.otpOrphans);
    document.getElementById('sec-admin-actions').textContent = formatNumber(s.recentAdminActions);
    document.getElementById('sec-unverified-count').textContent = formatNumber(s.emailUnverified30d);

    // Badge nav
    const urgent = s.suspendedCount + s.resetStale + s.reportsPending + s.disputesOpen;
    const badge = document.getElementById('badge-security');
    if (urgent > 0) { badge.textContent = urgent; badge.style.display = ''; }
    else badge.style.display = 'none';
  } catch (err) {
    showToast('Erreur stats sécurité', true);
  }
}

async function loadSecurityAlerts() {
  try {
    const d = await apiCall('/admin/security/alerts');
    const container = document.getElementById('sec-alerts-container');
    const parts = [];

    if (d.staleResets && d.staleResets.length > 0) {
      parts.push(
        '<div style="margin-bottom:14px;">'
        + '<div style="font-size:13px;font-weight:600;color:var(--orange);margin-bottom:8px;">🔑 Resets de mot de passe non utilisés depuis +1h (' + d.staleResets.length + ')</div>'
        + d.staleResets.map(u =>
          '<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--dark2);border-radius:8px;margin-bottom:4px;font-size:12px;">'
          + '<span>' + escHtml(u.firstName + ' ' + u.lastName) + ' — ' + escHtml(u.email) + '</span>'
          + '<span style="color:var(--muted);">' + new Date(u.updatedAt).toLocaleString('fr-FR') + '</span>'
          + '</div>'
        ).join('')
        + '</div>'
      );
    }

    if (d.unverifiedOld && d.unverifiedOld.length > 0) {
      parts.push(
        '<div style="margin-bottom:14px;">'
        + '<div style="font-size:13px;font-weight:600;color:var(--blue);margin-bottom:8px;">📧 Emails non vérifiés depuis +30j (' + d.unverifiedOld.length + ')</div>'
        + d.unverifiedOld.slice(0,10).map(u =>
          '<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--dark2);border-radius:8px;margin-bottom:4px;font-size:12px;">'
          + '<span>' + escHtml(u.firstName + ' ' + u.lastName) + ' — ' + escHtml(u.email) + '</span>'
          + '<span style="color:var(--muted);">' + new Date(u.createdAt).toLocaleDateString('fr-FR') + '</span>'
          + '</div>'
        ).join('')
        + (d.unverifiedOld.length > 10 ? '<div style="font-size:11px;color:var(--muted);padding:4px 10px;">+ ' + (d.unverifiedOld.length - 10) + ' autres…</div>' : '')
        + '</div>'
      );
    }

    if (d.otpOrphans && d.otpOrphans.length > 0) {
      parts.push(
        '<div>'
        + '<div style="font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px;">📱 OTP expirés non nettoyés (' + d.otpOrphans.length + ')</div>'
        + '<div style="font-size:12px;color:var(--muted);">Ces codes sont inoffensifs mais encombrent la base. Utilisez le nettoyage automatique.</div>'
        + '</div>'
      );
    }

    container.innerHTML = parts.length > 0
      ? parts.join('')
      : '<div style="display:flex;align-items:center;gap:10px;color:var(--green);font-size:14px;">✅ Aucune alerte sécurité active</div>';
  } catch (err) {
    document.getElementById('sec-alerts-container').innerHTML = '<div style="color:var(--muted);font-size:13px;">Erreur chargement alertes</div>';
  }
}

async function loadSuspended(page) {
  try {
    const search = document.getElementById('sec-susp-search').value.trim();
    const params = '?page=' + page + '&limit=20' + (search ? '&search=' + encodeURIComponent(search) : '');
    const data = await apiCall('/admin/security/suspended' + params);
    const tbody = document.getElementById('sec-susp-tbody');
    const empty = document.getElementById('sec-susp-empty');
    const pagination = document.getElementById('sec-susp-pagination');
    const users = data.users || [];

    if (users.length === 0) {
      tbody.innerHTML = ''; empty.style.display = ''; pagination.innerHTML = ''; return;
    }
    empty.style.display = 'none';

    const roleLabel = { CLIENT: 'Client', PROFESSIONAL: 'Pro', ADMIN: 'Admin' };
    tbody.innerHTML = users.map(u =>
      '<tr>'
      + '<td><strong>' + escHtml(u.firstName + ' ' + u.lastName) + '</strong></td>'
      + '<td>' + escHtml(u.email) + '</td>'
      + '<td><span class="badge badge-' + (u.role === 'PROFESSIONAL' ? 'orange' : 'blue') + '">' + (roleLabel[u.role] || u.role) + '</span></td>'
      + '<td style="color:var(--muted);font-size:12px;">' + escHtml(u.city || '--') + '</td>'
      + '<td style="color:var(--muted);font-size:12px;">' + new Date(u.updatedAt).toLocaleDateString('fr-FR') + '</td>'
      + '<td><button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;color:var(--green);" onclick="reactivateUser(\'' + u.id + '\',\'' + escHtml(u.firstName + ' ' + u.lastName).replace(/'/g,'') + '\')">✅ Réactiver</button></td>'
      + '</tr>'
    ).join('');

    if (data.totalPages > 1) {
      let html = '';
      if (page > 1) html += '<button class="btn btn-secondary" onclick="loadSuspended(' + (page-1) + ')">← Précédent</button>';
      html += '<span style="color:var(--muted);font-size:13px;">Page ' + page + ' / ' + data.totalPages + '</span>';
      if (page < data.totalPages) html += '<button class="btn btn-secondary" onclick="loadSuspended(' + (page+1) + ')">Suivant →</button>';
      pagination.innerHTML = html;
    } else {
      pagination.innerHTML = '';
    }
  } catch (err) {
    showToast('Erreur comptes suspendus', true);
  }
}

function debounceSecSearch() {
  clearTimeout(secDebounceTimer);
  secDebounceTimer = setTimeout(() => loadSuspended(1), 350);
}

async function reactivateUser(userId, name) {
  if (!confirm('Réactiver le compte de ' + name + ' ?')) return;
  try {
    await apiCall('/admin/users/' + userId + '/reactivate', { method: 'PATCH' });
    showToast('✅ Compte de ' + name + ' réactivé');
    loadSecurityStats();
    loadSuspended(1);
  } catch (err) {
    showToast('Erreur : ' + (err.message || 'Réactivation échouée'), true);
  }
}

async function cleanOtps() {
  if (!confirm('Nettoyer tous les OTP et codes de reset expirés ?')) return;
  try {
    const res = await apiCall('/admin/security/clean-otps', { method: 'POST' });
    showToast('✅ ' + res.cleaned + ' enregistrement(s) nettoyé(s) — OTP: ' + res.otpCleaned + ', Resets: ' + res.resetCleaned);
    loadSecurityStats();
    loadSecurityAlerts();
  } catch (err) {
    showToast('Erreur nettoyage : ' + (err.message || 'Échec'), true);
  }
}

async function loadSecurityActivity() {
  try {
    const data = await apiCall('/admin/security/activity?limit=30');
    const tbody = document.getElementById('sec-activity-tbody');
    const empty = document.getElementById('sec-activity-empty');
    const events = data.events || [];

    if (events.length === 0) {
      tbody.innerHTML = ''; empty.style.display = ''; return;
    }
    empty.style.display = 'none';

    const typeColors = { broadcast: 'blue', dispute: 'orange', report: 'purple', payment: 'green' };
    const typeLabels = { broadcast: '📡 Broadcast', dispute: '⚖️ Litige', report: '🛡️ Signalement', payment: '💳 Paiement' };
    tbody.innerHTML = events.map(e =>
      '<tr>'
      + '<td style="font-size:12px;color:var(--muted);white-space:nowrap;">' + new Date(e.date).toLocaleString('fr-FR') + '</td>'
      + '<td><span class="badge badge-' + (typeColors[e.type] || 'muted') + '">' + (typeLabels[e.type] || e.type) + '</span></td>'
      + '<td style="font-size:13px;">' + escHtml(e.summary) + '</td>'
      + '</tr>'
    ).join('');
  } catch (err) {
    showToast('Erreur journal activité', true);
  }
}

// ══════════════════════════════════════════════════════════════
// MARCHÉ & OPPORTUNITÉS
// ══════════════════════════════════════════════════════════════

let marketData = null;

async function loadMarket() {
  try {
    const d = await apiCall('/admin/market');
    marketData = d;
    const k = d.kpis;
    const shortLabels = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

    // ── KPIs ──
    document.getElementById('mkt-open').textContent        = formatNumber(k.totalOpenProjects);
    document.getElementById('mkt-stale').textContent       = formatNumber(k.openStale);
    document.getElementById('mkt-coverage').textContent    = k.coverageRate + '%';
    document.getElementById('mkt-delay').textContent       = k.avgHoursToFirstQuote != null ? k.avgHoursToFirstQuote + 'h' : '--';
    document.getElementById('mkt-budget-min').textContent  = formatCurrency(k.avgBudgetMin) + ' FCFA';
    document.getElementById('mkt-budget-max').textContent  = formatCurrency(k.avgBudgetMax) + ' FCFA';
    document.getElementById('mkt-pros').textContent        = formatNumber(k.totalPros);
    document.getElementById('mkt-verified-pros').textContent = formatNumber(k.verifiedPros);

    // ── Graphique projets par mois ──
    const months = Object.entries(d.projectsByMonth || {});
    const maxVal = Math.max(...months.map(([,v]) => v), 1);
    const total12 = months.reduce((a,[,v]) => a + v, 0);
    document.getElementById('mkt-chart-label').textContent = total12 + ' projets créés sur les 12 derniers mois';
    document.getElementById('mkt-bar-chart').innerHTML = months.map(([key, v]) => {
      const h = Math.max(4, (v / maxVal) * 90);
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">'
        + '<div style="font-size:9px;color:var(--muted);">' + (v > 0 ? v : '') + '</div>'
        + '<div style="width:100%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--blue),rgba(59,130,246,0.3));height:' + h + 'px;transition:height .5s;" title="' + key + ' : ' + v + ' projet(s)"></div>'
        + '</div>';
    }).join('');
    document.getElementById('mkt-bar-labels').innerHTML = months.map(([key]) => {
      const m = parseInt(key.split('-')[1]) - 1;
      return '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);">' + shortLabels[m] + '</div>';
    }).join('');

    // ── Demande vs offre par métier ──
    const maxDemand = Math.max(...(d.tradeBalance || []).map(t => t.demand), 1);
    document.getElementById('mkt-trade-balance').innerHTML = (d.tradeBalance || []).map(t => {
      const pctBar = Math.max(2, (t.demand / maxDemand) * 100);
      const ratio  = t.supply > 0 ? t.ratio : '∞';
      const ratioColor = !t.supply ? 'red' : parseFloat(t.ratio) > 3 ? 'orange' : 'green';
      return '<div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:3px;">'
        + '<span style="font-size:12px;color:var(--text);">' + escHtml(t.trade) + '</span>'
        + '<span style="font-size:11px;">'
        + '<span style="color:var(--blue);">' + t.demand + ' proj</span>'
        + ' · <span style="color:var(--muted);">' + t.supply + ' pros</span>'
        + ' · <span style="color:var(--' + ratioColor + ');font-weight:600;" title="Ratio demande/pros">' + ratio + '</span>'
        + '</span></div>'
        + '<div style="background:var(--dark2);border-radius:3px;height:5px;">'
        + '<div style="background:var(--blue);border-radius:3px;height:100%;width:' + pctBar + '%;"></div>'
        + '</div></div>';
    }).join('') || '<span style="color:var(--muted);font-size:13px;">Aucune donnée</span>';

    // ── Budget par métier ──
    document.getElementById('mkt-budget-tbody').innerHTML = (d.budgetByTrade || []).map(t =>
      '<tr>'
      + '<td>' + escHtml(t.trade) + '</td>'
      + '<td style="text-align:center;">' + t.count + '</td>'
      + '<td style="color:var(--green);">' + formatCurrency(t.avgMin) + ' FCFA</td>'
      + '<td style="color:var(--orange);">' + formatCurrency(t.avgMax) + ' FCFA</td>'
      + '</tr>'
    ).join('') || '<tr><td colspan="4" style="color:var(--muted);text-align:center;">Aucune donnée budget</td></tr>';

    // ── Villes : demande vs offre ──
    const maxCity = Math.max(...(d.cityMarket || []).map(c => c.demand), 1);
    document.getElementById('mkt-city-bars').innerHTML = (d.cityMarket || []).map(c => {
      const pct   = Math.max(2, (c.demand / maxCity) * 100);
      const gap   = c.supply === 0 ? 'red' : c.demand > c.supply * 2 ? 'orange' : 'green';
      const gapLabel = c.supply === 0 ? '⚠️ 0 pro' : c.demand > c.supply * 2 ? '⚠️ sous-couvert' : '✅ couvert';
      return '<div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:3px;">'
        + '<span style="font-size:12px;color:var(--text);">' + escHtml(c.city) + '</span>'
        + '<span style="font-size:11px;">'
        + '<span style="color:var(--blue);">' + c.demand + ' proj</span>'
        + ' · <span style="color:var(--muted);">' + c.supply + ' pros</span>'
        + ' · <span style="color:var(--' + gap + ');">' + gapLabel + '</span>'
        + '</span></div>'
        + '<div style="background:var(--dark2);border-radius:3px;height:5px;">'
        + '<div style="background:var(--' + gap + ');border-radius:3px;height:100%;width:' + pct + '%;"></div>'
        + '</div></div>';
    }).join('') || '<span style="color:var(--muted);font-size:13px;">Aucune donnée</span>';

    // ── Projets sans réponse ──
    const stale = d.staleProjects || [];
    const staleEmpty = document.getElementById('mkt-stale-empty');
    const staleTbody = document.getElementById('mkt-stale-tbody');
    if (stale.length === 0) {
      staleTbody.innerHTML = '';
      staleEmpty.style.display = '';
    } else {
      staleEmpty.style.display = 'none';
      staleTbody.innerHTML = stale.map(p => {
        const ageDays = Math.floor((new Date() - new Date(p.createdAt)) / (1000 * 60 * 60 * 24));
        const budget  = (p.budgetMin || p.budgetMax)
          ? formatCurrency(p.budgetMin || 0) + ' – ' + formatCurrency(p.budgetMax || 0) + ' FCFA'
          : '--';
        const client  = p.client ? escHtml(p.client.firstName + ' ' + p.client.lastName) : '--';
        return '<tr>'
          + '<td><strong>' + client + '</strong><br><span style="font-size:11px;color:var(--muted);">' + escHtml(p.client?.email || '') + '</span></td>'
          + '<td>' + escHtml(p.title) + '</td>'
          + '<td>' + escHtml(p.tradeNeeded) + '</td>'
          + '<td>' + escHtml(p.city) + '</td>'
          + '<td style="font-size:12px;">' + budget + '</td>'
          + '<td style="font-size:12px;color:var(--muted);">' + new Date(p.createdAt).toLocaleDateString('fr-FR') + '</td>'
          + '<td><span style="color:var(--red);font-weight:600;">' + ageDays + 'j</span></td>'
          + '</tr>';
      }).join('');
    }
  } catch (err) {
    showToast('Erreur chargement marché', true);
  }
}

async function exportMarketCSV() {
  try {
    if (!marketData || !marketData.staleProjects) {
      showToast('Chargez d\'abord la page', true); return;
    }
    const rows = marketData.staleProjects;
    if (rows.length === 0) { showToast('Aucun projet sans réponse à exporter', true); return; }
    const headers = ['Client', 'Email', 'Titre', 'Métier', 'Ville', 'Budget min (FCFA)', 'Budget max (FCFA)', 'Publié le', 'Âge (jours)'];
    const csvRows = rows.map(p => {
      const ageDays = Math.floor((new Date() - new Date(p.createdAt)) / (1000 * 60 * 60 * 24));
      return [
        (p.client?.firstName || '') + ' ' + (p.client?.lastName || ''),
        p.client?.email || '',
        p.title,
        p.tradeNeeded,
        p.city,
        p.budgetMin || '',
        p.budgetMax || '',
        new Date(p.createdAt).toLocaleDateString('fr-FR'),
        ageDays,
      ].map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',');
    });
    const csv = '﻿' + headers.join(',') + '\n' + csvRows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'manawa_marche_opportunites.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('✅ Export CSV téléchargé');
  } catch (err) {
    showToast('Erreur export', true);
  }
}

// ══════════════════════════════════════════════════════════════
// GESTION DES ABONNEMENTS
// ══════════════════════════════════════════════════════════════

let currentSubProId = null;
let subDebounceTimer = null;

const TIER_CONFIG = {
  ESSENTIEL: { label: 'Essentiel', color: 'blue',   price: 2500  },
  PRO:       { label: 'Pro',       color: 'orange',  price: 5000  },
  ELITE:     { label: 'Élite',     color: 'gold',    price: 10000 },
};

async function loadSubStats() {
  try {
    const s = await apiCall('/admin/subscriptions/stats');

    document.getElementById('sub-active').textContent   = formatNumber(s.totalActive);
    document.getElementById('sub-revenue').textContent  = formatCurrency(s.estimatedRevenue) + ' FCFA';
    document.getElementById('sub-expiring').textContent = formatNumber(s.expiringIn7d);
    document.getElementById('sub-trials').textContent   = formatNumber(s.trialsActive);

    // Distribution par tier
    const total = s.totalActive || 1;
    const tierOrder = ['ELITE', 'PRO', 'ESSENTIEL'];
    document.getElementById('sub-tier-bars').innerHTML = tierOrder.map(tier => {
      const cfg   = TIER_CONFIG[tier];
      const count = (s.byTier || {})[tier] || 0;
      const pct   = Math.round((count / total) * 100);
      return '<div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">'
        + '<span style="font-size:13px;color:var(--text);">' + cfg.label + '</span>'
        + '<span style="font-size:13px;font-weight:600;color:var(--' + cfg.color + ');">' + count + ' <span style="font-size:11px;color:var(--muted);">(' + pct + '%)</span></span>'
        + '</div>'
        + '<div style="background:var(--dark2);border-radius:4px;height:8px;">'
        + '<div style="background:var(--' + cfg.color + ');border-radius:4px;height:100%;width:' + Math.max(2, pct) + '%;transition:width .5s;"></div>'
        + '</div></div>';
    }).join('');

    // Graphique mensuel
    const months = Object.entries(s.monthlyGrowth || {});
    const maxVal = Math.max(...months.map(([,v]) => v), 1);
    const shortLabels = ['J','F','M','A','M','J','J','A','S','O','N','D'];
    document.getElementById('sub-chart-label').textContent = 'Total activations sur 12 mois : ' + months.reduce((a,[,v]) => a+v, 0);
    document.getElementById('sub-bar-chart').innerHTML = months.map(([key, v]) => {
      const h = Math.max(4, (v / maxVal) * 90);
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">'
        + '<div style="font-size:9px;color:var(--muted);">' + (v > 0 ? v : '') + '</div>'
        + '<div style="width:100%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--gold),rgba(232,184,75,0.3));height:' + h + 'px;transition:height .5s;" title="' + key + ' : ' + v + ' activation(s)"></div>'
        + '</div>';
    }).join('');
    document.getElementById('sub-bar-labels').innerHTML = months.map(([key]) => {
      const month = parseInt(key.split('-')[1]) - 1;
      return '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);">' + shortLabels[month] + '</div>';
    }).join('');
  } catch (err) {
    showToast('Erreur stats abonnements', true);
  }
}

async function loadSubscriptions(page) {
  try {
    const search = document.getElementById('sub-search').value.trim();
    const status = document.getElementById('sub-status-filter').value;
    const tier   = document.getElementById('sub-tier-filter').value;
    const params = '?page=' + page + '&limit=20'
      + (status ? '&status=' + encodeURIComponent(status) : '')
      + (tier   ? '&tier='   + encodeURIComponent(tier)   : '')
      + (search ? '&search=' + encodeURIComponent(search) : '');

    const data = await apiCall('/admin/subscriptions' + params);
    const tbody = document.getElementById('sub-tbody');
    const empty = document.getElementById('sub-empty');
    const pagination = document.getElementById('sub-pagination');
    const subs = data.subscriptions || [];

    if (subs.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = '';
      pagination.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    const now = new Date();
    tbody.innerHTML = subs.map(s => {
      const u    = s.professional?.user || {};
      const name = escHtml((u.firstName || '') + ' ' + (u.lastName || ''));
      const cfg  = TIER_CONFIG[s.tier] || { label: s.tier, color: 'muted' };
      const isActive  = s.status === 'ACTIVE' && s.expiresAt && new Date(s.expiresAt) > now;
      const isExpiring = isActive && new Date(s.expiresAt) < new Date(now.getTime() + 7*24*60*60*1000);
      const statusBadge = isExpiring
        ? '<span class="badge badge-orange">Expire bientôt</span>'
        : isActive
          ? '<span class="badge badge-green">Actif</span>'
          : '<span class="badge" style="color:var(--muted);">Inactif</span>';
      const trial = s.professional?.trialEndsAt && new Date(s.professional.trialEndsAt) > now;
      const trialBadge = trial ? ' <span class="badge badge-blue" style="font-size:10px;">Essai</span>' : '';
      return '<tr>'
        + '<td><strong>' + name + '</strong>' + trialBadge + '<br><span style="font-size:11px;color:var(--muted);">' + escHtml(u.email || '') + '</span></td>'
        + '<td style="font-size:12px;">' + escHtml(s.professional?.trade || '--') + '<br><span style="color:var(--muted);">' + escHtml(s.professional?.city || '--') + '</span></td>'
        + '<td><span class="badge badge-' + cfg.color + '">' + cfg.label + '</span></td>'
        + '<td>' + statusBadge + '</td>'
        + '<td style="font-size:12px;color:var(--muted);">' + (s.startedAt ? new Date(s.startedAt).toLocaleDateString('fr-FR') : '--') + '</td>'
        + '<td style="font-size:12px;' + (isExpiring ? 'color:var(--orange);font-weight:600;' : 'color:var(--muted);') + '">' + (s.expiresAt ? new Date(s.expiresAt).toLocaleDateString('fr-FR') : '--') + '</td>'
        + '<td><button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="openSubModal(\'' + s.professional.id + '\',\'' + name.replace(/'/g,"") + '\',\'' + escHtml(u.email||'') + '\',\'' + s.tier + '\',\'' + (isActive ? 'Actif' : 'Inactif') + '\',\'' + (s.expiresAt ? new Date(s.expiresAt).toLocaleDateString('fr-FR') : '--') + '\')">Gérer</button></td>'
        + '</tr>';
    }).join('');

    if (data.totalPages > 1) {
      let html = '';
      if (page > 1) html += '<button class="btn btn-secondary" onclick="loadSubscriptions(' + (page-1) + ')">← Précédent</button>';
      html += '<span style="color:var(--muted);font-size:13px;">Page ' + page + ' / ' + data.totalPages + '</span>';
      if (page < data.totalPages) html += '<button class="btn btn-secondary" onclick="loadSubscriptions(' + (page+1) + ')">Suivant →</button>';
      pagination.innerHTML = html;
    } else {
      pagination.innerHTML = '';
    }
  } catch (err) {
    showToast('Erreur chargement abonnements', true);
  }
}

function debounceSubSearch() {
  clearTimeout(subDebounceTimer);
  subDebounceTimer = setTimeout(() => loadSubscriptions(1), 350);
}

function openSubModal(proId, name, email, tier, statusLabel, expiresAt) {
  currentSubProId = proId;
  document.getElementById('sub-modal-title').textContent = 'Abonnement — ' + name;
  document.getElementById('sub-modal-pro').textContent   = name;
  document.getElementById('sub-modal-email').textContent = email;
  document.getElementById('sub-modal-current').textContent = 'Statut actuel : ' + statusLabel + ' · Expiration : ' + expiresAt;
  document.getElementById('sub-modal-tier').value = ['ESSENTIEL','PRO','ELITE'].includes(tier) ? tier : 'PRO';
  document.getElementById('modal-subscription').classList.add('show');
}

async function subAction(action) {
  const tier = document.getElementById('sub-modal-tier').value;
  const confirmMessages = {
    activate: 'Activer/changer le tier "' + tier + '" pour 1 mois ?',
    extend:   'Prolonger cet abonnement de 1 mois ?',
    cancel:   'Annuler cet abonnement ? Le professionnel perdra ses avantages premium.',
  };
  if (!confirm(confirmMessages[action])) return;

  try {
    await apiCall('/admin/subscriptions/' + currentSubProId, {
      method: 'PATCH',
      body: JSON.stringify({ action, tier }),
    });
    showToast('✅ Abonnement mis à jour');
    closeModal('modal-subscription');
    loadSubStats();
    loadSubscriptions(1);
  } catch (err) {
    showToast('Erreur : ' + (err.message || 'Mise à jour échouée'), true);
  }
}

// ══════════════════════════════════════════════════════════════
// LITIGES & REMBOURSEMENTS
// ══════════════════════════════════════════════════════════════

let currentDisputeId = null;
let disDebounceTimer = null;

const DISPUTE_STATUS_LABELS = {
  OPEN: { label: 'Ouvert', color: 'red' },
  UNDER_REVIEW: { label: 'En examen', color: 'orange' },
  RESOLVED_REFUND: { label: 'Remboursé', color: 'green' },
  RESOLVED_PARTIAL: { label: 'Partiel', color: 'blue' },
  RESOLVED_REJECTED: { label: 'Rejeté', color: 'muted' },
};

async function loadDisputeStats() {
  try {
    const s = await apiCall('/admin/disputes/stats');
    document.getElementById('dis-open').textContent     = formatNumber(s.open);
    document.getElementById('dis-review').textContent   = formatNumber(s.underReview);
    document.getElementById('dis-resolved').textContent = formatNumber(s.resolvedRefund + s.resolvedPartial);
    document.getElementById('dis-refunded').textContent = formatCurrency(s.totalRefunded) + ' FCFA';

    // Badge nav
    const badge = document.getElementById('badge-disputes');
    const urgent = s.open + s.underReview;
    if (urgent > 0) {
      badge.textContent = urgent;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (err) {
    // silencieux si page non active
  }
}

async function loadDisputes(page) {
  try {
    const search = document.getElementById('dis-search').value.trim();
    const status = document.getElementById('dis-status-filter').value;
    const params = '?page=' + page + '&limit=20'
      + (status ? '&status=' + encodeURIComponent(status) : '')
      + (search ? '&search=' + encodeURIComponent(search) : '');

    const data = await apiCall('/admin/disputes' + params);
    const tbody = document.getElementById('dis-tbody');
    const empty = document.getElementById('dis-empty');
    const pagination = document.getElementById('dis-pagination');

    const disputes = data.disputes || [];
    if (disputes.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = '';
      pagination.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = disputes.map(d => {
      const st = DISPUTE_STATUS_LABELS[d.status] || { label: d.status, color: 'muted' };
      const client = d.client ? escHtml(d.client.firstName + ' ' + d.client.lastName) : '--';
      const pro    = d.payment?.quote?.professional?.user;
      const proName = pro ? escHtml(pro.firstName + ' ' + pro.lastName) : '--';
      const project = d.payment?.quote?.project?.title || '--';
      const amount  = d.payment?.amount != null ? formatCurrency(d.payment.amount) + ' FCFA' : '--';
      return '<tr>'
        + '<td style="font-size:12px;color:var(--muted);">' + new Date(d.createdAt).toLocaleDateString('fr-FR') + '</td>'
        + '<td><strong>' + client + '</strong><br><span style="font-size:11px;color:var(--muted);">' + escHtml(d.client?.email || '') + '</span></td>'
        + '<td><span style="font-size:13px;">' + escHtml(project) + '</span><br><span style="font-size:11px;color:var(--muted);">' + proName + '</span></td>'
        + '<td style="font-weight:600;color:var(--green);">' + amount + '</td>'
        + '<td style="max-width:160px;font-size:13px;">' + escHtml(d.reason) + '</td>'
        + '<td><span class="badge badge-' + st.color + '">' + st.label + '</span></td>'
        + '<td><button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="openDisputeModal(\'' + d.id + '\')">Gérer</button></td>'
        + '</tr>';
    }).join('');

    // Pagination
    if (data.totalPages > 1) {
      let html = '';
      if (page > 1) html += '<button class="btn btn-secondary" onclick="loadDisputes(' + (page-1) + ')">← Précédent</button>';
      html += '<span style="color:var(--muted);font-size:13px;">Page ' + page + ' / ' + data.totalPages + '</span>';
      if (page < data.totalPages) html += '<button class="btn btn-secondary" onclick="loadDisputes(' + (page+1) + ')">Suivant →</button>';
      pagination.innerHTML = html;
    } else {
      pagination.innerHTML = '';
    }
  } catch (err) {
    showToast('Erreur chargement litiges', true);
  }
}

function debounceDisSearch() {
  clearTimeout(disDebounceTimer);
  disDebounceTimer = setTimeout(() => loadDisputes(1), 350);
}

let _disputeClientId = null, _disputeProUserId = null;

async function openDisputeModal(id) {
  try {
    currentDisputeId = id;
    const d = await apiCall('/admin/disputes/' + id);

    document.getElementById('dis-modal-title').textContent = 'Litige — ' + (DISPUTE_STATUS_LABELS[d.status]?.label || d.status);

    const client = d.client || {};
    const pro    = d.payment?.quote?.professional?.user || {};

    _disputeClientId  = client.id   || null;
    _disputeProUserId = pro.id       || null;

    const clientName = (client.firstName || '') + ' ' + (client.lastName || '');
    const proName    = (pro.firstName    || '') + ' ' + (pro.lastName    || '');

    document.getElementById('dis-modal-client').textContent       = clientName;
    document.getElementById('dis-modal-client-email').textContent = client.email || '';
    document.getElementById('dis-modal-pro').textContent          = proName;
    document.getElementById('dis-modal-pro-email').textContent    = pro.email || '';
    document.getElementById('dis-modal-project').textContent      = d.payment?.quote?.project?.title || '--';
    document.getElementById('dis-modal-amount').textContent       = formatCurrency(d.payment?.amount || 0) + ' FCFA';
    document.getElementById('dis-modal-reason').textContent       = d.reason;
    document.getElementById('dis-modal-desc').textContent         = d.description || '(aucune description)';
    document.getElementById('dis-modal-note').value               = d.adminNote || '';
    document.getElementById('dis-modal-status').value             = d.status;
    document.getElementById('dis-modal-refund').value             = d.refundAmount || '';

    // Griser le bouton messagerie si l'un des deux users est absent
    const msgBtn = document.getElementById('dis-msg-btn');
    if (_disputeClientId && _disputeProUserId) {
      msgBtn.disabled = false;
      msgBtn.title = 'Voir la conversation ' + clientName.trim() + ' ↔ ' + proName.trim();
    } else {
      msgBtn.disabled = true;
      msgBtn.title = 'Participants introuvables';
    }

    toggleRefundField();
    document.getElementById('modal-dispute').classList.add('show');
  } catch (err) {
    showToast('Erreur chargement litige', true);
  }
}

async function openDisputeConversation() {
  if (!_disputeClientId || !_disputeProUserId) return;
  const clientName = document.getElementById('dis-modal-client').textContent;
  const proName    = document.getElementById('dis-modal-pro').textContent;
  closeModal('modal-dispute');
  showPage('messaging');
  // Laisser la page se rendre, puis ouvrir le thread
  await new Promise(r => setTimeout(r, 120));
  openMsgThread(_disputeClientId, _disputeProUserId, clientName, proName);
}

function toggleRefundField() {
  const status = document.getElementById('dis-modal-status').value;
  const show = status === 'RESOLVED_REFUND' || status === 'RESOLVED_PARTIAL';
  document.getElementById('dis-refund-field').style.display = show ? '' : 'none';
}

async function saveDisputeStatus() {
  const status      = document.getElementById('dis-modal-status').value;
  const adminNote   = document.getElementById('dis-modal-note').value.trim();
  const refundAmount = parseFloat(document.getElementById('dis-modal-refund').value);

  if ((status === 'RESOLVED_REFUND' || status === 'RESOLVED_PARTIAL') && (!refundAmount || refundAmount <= 0)) {
    showToast('Saisissez un montant de remboursement', true);
    return;
  }

  try {
    await apiCall('/admin/disputes/' + currentDisputeId + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status, adminNote, refundAmount: refundAmount || undefined }),
    });
    showToast('✅ Litige mis à jour');
    closeModal('modal-dispute');
    loadDisputeStats();
    loadDisputes(1);
  } catch (err) {
    showToast('Erreur : ' + (err.message || 'Mise à jour échouée'), true);
  }
}

// ══════════════════════════════════════════════════════════════
// COMMUNICATION
// ══════════════════════════════════════════════════════════════

async function loadCommunication() {
  try {
    const data = await apiCall('/admin/communication/stats');

    document.getElementById('com-messages-30d').textContent    = formatNumber(data.messages.last30d);
    document.getElementById('com-notifs-30d').textContent      = formatNumber(data.notifications.last30d);
    document.getElementById('com-devices').textContent         = formatNumber(data.devices.active);
    document.getElementById('com-broadcasts').textContent      = formatNumber(data.broadcasts.total);
    document.getElementById('com-messages-total').textContent  = formatNumber(data.messages.total);
    document.getElementById('com-conversations').textContent   = formatNumber(data.messages.activeConversations);
    document.getElementById('com-notifs-total').textContent    = formatNumber(data.notifications.total);
    document.getElementById('com-notifs-unread').textContent   = formatNumber(data.notifications.unread);

    // Appareils par plateforme
    const platformColors = { ANDROID: 'green', iOS: 'blue', FCM: 'orange', EXPO: 'purple', APNs: 'blue' };
    document.getElementById('com-devices-breakdown').innerHTML =
      (data.devices.byPlatform || []).map(d =>
        '<div style="background:var(--dark2);border:1px solid var(--border);border-radius:10px;padding:12px 20px;text-align:center;">'
        + '<div style="font-size:22px;font-weight:700;color:var(--' + (platformColors[d.platform] || 'text') + ');">' + formatNumber(d.count) + '</div>'
        + '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + escHtml(d.platform) + '</div>'
        + '</div>'
      ).join('') || '<span style="color:var(--muted);font-size:13px;">Aucun appareil enregistré</span>';

    await loadBroadcastHistory(1);
  } catch (err) {
    showToast('Erreur chargement communication', true);
  }
}

async function loadBroadcastHistory(page) {
  try {
    const data = await apiCall('/admin/communication/broadcasts?page=' + page + '&limit=20');
    const tbody = document.getElementById('com-broadcasts-tbody');
    const empty = document.getElementById('com-broadcasts-empty');
    const pagination = document.getElementById('com-broadcasts-pagination');

    const logs = data.logs || [];
    if (logs.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = '';
      pagination.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    const targetLabels = { ALL: '👥 Tous', CLIENTS: '🏠 Clients', PROFESSIONALS: '🔧 Pros', USER: '👤 Utilisateur' };
    tbody.innerHTML = logs.map(l => {
      const rate = l.total > 0 ? Math.round((l.sent / l.total) * 100) : 0;
      const rateColor = rate >= 80 ? 'green' : rate >= 50 ? 'orange' : 'red';
      return '<tr>'
        + '<td style="font-size:12px;color:var(--muted);">' + new Date(l.createdAt).toLocaleString('fr-FR') + '</td>'
        + '<td style="font-weight:600;">' + escHtml(l.title) + '</td>'
        + '<td style="max-width:220px;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(l.body) + '">' + escHtml(l.body) + '</td>'
        + '<td><span class="badge badge-blue">' + (targetLabels[l.target] || l.target) + '</span></td>'
        + '<td><span style="color:var(--' + rateColor + ');font-weight:600;">' + l.sent + ' / ' + l.total + '</span> <span style="color:var(--muted);font-size:11px;">(' + rate + '%)</span></td>'
        + '</tr>';
    }).join('');

    // Pagination
    if (data.totalPages > 1) {
      let html = '';
      if (page > 1) html += '<button class="btn btn-secondary" onclick="loadBroadcastHistory(' + (page-1) + ')">← Précédent</button>';
      html += '<span style="color:var(--muted);font-size:13px;">Page ' + page + ' / ' + data.totalPages + '</span>';
      if (page < data.totalPages) html += '<button class="btn btn-secondary" onclick="loadBroadcastHistory(' + (page+1) + ')">Suivant →</button>';
      pagination.innerHTML = html;
    } else {
      pagination.innerHTML = '';
    }
  } catch (err) {
    showToast('Erreur chargement historique', true);
  }
}

function toggleUserIdField() {
  const target = document.getElementById('com-notif-target').value;
  document.getElementById('com-user-id-field').style.display = target === 'USER' ? '' : 'none';
}

async function sendBroadcast() {
  const title  = document.getElementById('com-notif-title').value.trim();
  const body   = document.getElementById('com-notif-body').value.trim();
  const target = document.getElementById('com-notif-target').value;
  const targetUser = document.getElementById('com-target-user').value.trim();

  if (!title) { showToast('Le titre est requis', true); return; }
  if (!body)  { showToast('Le message est requis', true); return; }
  if (target === 'USER' && !targetUser) { showToast('Saisissez un ID utilisateur', true); return; }

  const targetLabels = { ALL: 'tous les utilisateurs', CLIENTS: 'tous les clients', PROFESSIONALS: 'tous les professionnels', USER: 'un utilisateur précis' };
  const confirmed = confirm('Envoyer "' + title + '" à ' + targetLabels[target] + ' ?');
  if (!confirmed) return;

  try {
    showToast('Envoi en cours…');
    const payload = { title, body, target };
    if (target === 'USER') payload.targetUserId = targetUser;

    const res = await apiCall('/admin/communication/broadcast', { method: 'POST', body: JSON.stringify(payload) });
    showToast('✅ Notification envoyée — ' + res.sent + ' / ' + res.total + ' appareils atteints');

    // Vider les champs
    document.getElementById('com-notif-title').value = '';
    document.getElementById('com-notif-body').value  = '';
    document.getElementById('com-target-user').value = '';
    document.getElementById('com-notif-target').value = 'ALL';
    toggleUserIdField();

    // Rafraîchir les stats et l'historique
    loadCommunication();
  } catch (err) {
    showToast('Erreur : ' + (err.message || 'Envoi échoué'), true);
  }
}

// ══════════════════════════════════════════════════════════════
// SUPPORT
// ══════════════════════════════════════════════════════════════
let currentSupportTicketId = null;
let supportDebounceTimer = null;

const SUPPORT_CATEGORIES = { PAYMENT: '💳 Paiement', VERIFICATION: '🛡️ Vérification', DISPUTE: '⚠️ Litige', ACCOUNT: '👤 Compte', OTHER: '❓ Autre' };
const SUPPORT_STATUS = { OPEN: { label: 'Ouvert', badge: 'badge-blue' }, IN_PROGRESS: { label: 'En cours', badge: 'badge-yellow' }, RESOLVED: { label: 'Résolu', badge: 'badge-green' }, CLOSED: { label: 'Fermé', badge: 'badge-muted' } };
const CATEGORY_COLORS = { PAYMENT: 'var(--blue)', VERIFICATION: 'var(--green)', DISPUTE: 'var(--red)', ACCOUNT: 'var(--orange)', OTHER: 'var(--muted)' };

async function loadSupportStats() {
  try {
    const d = await apiCall('/admin/support/stats');
    document.getElementById('sup-kpi-total').textContent      = d.total;
    document.getElementById('sup-kpi-open').textContent       = d.open;
    document.getElementById('sup-kpi-inprogress').textContent = d.inProgress;
    document.getElementById('sup-kpi-resolved').textContent   = d.resolved + d.closed;
    document.getElementById('sup-kpi-avgtime').textContent    = d.avgResolutionHours !== null
      ? (d.avgResolutionHours < 24 ? d.avgResolutionHours + 'h' : Math.round(d.avgResolutionHours / 24) + 'j')
      : '—';

    // Mini-barres catégories
    const barsEl = document.getElementById('sup-category-bars');
    const total = d.total || 1;
    barsEl.innerHTML = Object.entries(SUPPORT_CATEGORIES).map(([key, label]) => {
      const count = d.byCategory[key] || 0;
      const pct   = Math.round(count / total * 100);
      const color = CATEGORY_COLORS[key] || 'var(--muted)';
      return `<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 12px;min-width:120px;flex:1;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;">
          <span>${label}</span><strong style="color:${color}">${count}</strong>
        </div>
        <div style="height:4px;background:var(--dark2);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;"></div>
        </div>
      </div>`;
    }).join('');
  } catch (e) { /* silencieux */ }
}

function debounceSupportSearch() {
  clearTimeout(supportDebounceTimer);
  supportDebounceTimer = setTimeout(() => loadSupportTickets(), 400);
}

async function loadSupportTickets() {
  try {
    const status   = document.getElementById('support-status-filter').value;
    const category = document.getElementById('support-category-filter').value;
    const search   = document.getElementById('support-search').value.trim();
    const params   = new URLSearchParams();
    if (status)   params.set('status', status);
    if (category) params.set('category', category);
    const qs  = params.toString();
    let url = '/admin/support/tickets' + (qs ? '?' + qs : '');
    const data = await apiCall(url);
    const tbody = document.getElementById('support-tbody');
    const empty = document.getElementById('support-empty');

    let tickets = data.tickets || [];

    // Filtrage côté client par recherche (ID, nom, email)
    if (search) {
      const q = search.toLowerCase();
      tickets = tickets.filter(t => {
        const name = ((t.user.firstName || '') + ' ' + (t.user.lastName || '')).toLowerCase();
        const email = (t.user.email || '').toLowerCase();
        const ticketId = (t.id || '').toLowerCase();
        const subject = (t.subject || '').toLowerCase();
        return ticketId.startsWith(q) || name.includes(q) || email.includes(q) || subject.includes(q);
      });
    }

    if (tickets.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    const openCount = tickets.filter(t => t.status === 'OPEN').length;
    const badge = document.getElementById('badge-support');
    if (openCount > 0) { badge.textContent = openCount; badge.style.display = ''; }
    else { badge.style.display = 'none'; }

    tbody.innerHTML = tickets.map(t => {
      const u = t.user;
      const name = (u.firstName || '') + ' ' + (u.lastName || '');
      const cat = SUPPORT_CATEGORIES[t.category] || t.category;
      const st = SUPPORT_STATUS[t.status] || SUPPORT_STATUS.OPEN;
      const lastMsg = t.messages && t.messages[0] ? (t.messages[0].isAdmin ? '🛡️ ' : '') + t.messages[0].content.substring(0, 50) : '-';
      return '<tr><td><span style="font-family:monospace;font-size:11px;color:var(--orange);cursor:pointer;" title="' + escAttr(t.id) + '" onclick="navigator.clipboard.writeText(\'' + escAttr(t.id) + '\');showToast(\'ID copié\')">#' + escHtml(t.id.substring(0, 6)) + '</span></td><td><strong>' + escHtml(name) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + escHtml(u.email) + '</span><br><span class="badge badge-' + (u.role === 'PROFESSIONAL' ? 'orange' : 'blue') + '" style="font-size:9px;margin-top:2px;">' + (u.role === 'PROFESSIONAL' ? 'Pro' : 'Client') + '</span></td><td>' + cat + '</td><td><strong>' + escHtml(t.subject) + '</strong></td><td><span class="badge ' + st.badge + '">' + st.label + '</span></td><td style="font-size:12px;color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(lastMsg) + '</td><td>' + formatDate(t.updatedAt) + '</td><td class="td-actions"><button class="btn btn-view" onclick="event.stopPropagation();openSupportTicket(\'' + t.id + '\')">💬 Ouvrir</button></td></tr>';
    }).join('');
  } catch (err) {
    void err;
  }
}

async function openSupportTicket(ticketId) {
  try {
    currentSupportTicketId = ticketId;
    const data = await apiCall('/admin/support/tickets/' + ticketId);
    document.getElementById('support-modal-title').textContent = data.subject;

    // Status select
    const sel = document.getElementById('support-modal-status');
    sel.innerHTML = Object.entries(SUPPORT_STATUS).map(([k, v]) => '<option value="' + k + '"' + (data.status === k ? ' selected' : '') + '>' + v.label + '</option>').join('');

    // Messages
    const msgEl = document.getElementById('support-modal-messages');
    msgEl.innerHTML = data.messages.map(m => {
      const isAdmin = m.isAdmin;
      const align = isAdmin ? 'flex-end' : 'flex-start';
      const bg = isAdmin ? 'rgba(244,114,11,0.15)' : 'var(--dark4)';
      const border = isAdmin ? '1px solid rgba(244,114,11,0.3)' : '1px solid var(--border)';
      const label = isAdmin ? '<span style="font-size:10px;color:var(--orange);font-weight:600;">🛡️ Support</span>' : '<span style="font-size:10px;color:var(--muted);">👤 ' + escHtml((data.user.firstName || '') + ' ' + (data.user.lastName || '')) + '</span>';
      return '<div style="display:flex;justify-content:' + align + ';margin-bottom:10px;"><div style="max-width:80%;background:' + bg + ';border:' + border + ';border-radius:14px;padding:10px 14px;">' + label + '<p style="color:var(--light);font-size:13px;margin-top:4px;line-height:1.5;">' + escHtml(m.content) + '</p><span style="font-size:10px;color:var(--muted);margin-top:4px;display:block;">' + formatDate(m.createdAt) + '</span></div></div>';
    }).join('');
    msgEl.scrollTop = msgEl.scrollHeight;

    document.getElementById('support-reply-input').value = '';
    document.getElementById('modal-support').classList.add('show');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function sendSupportReply() {
  const input = document.getElementById('support-reply-input');
  const message = input.value.trim();
  if (!message || !currentSupportTicketId) return;
  try {
    await apiCall('/admin/support/tickets/' + currentSupportTicketId + '/reply', { method: 'POST', body: JSON.stringify({ message }) });
    input.value = '';
    showToast('Réponse envoyée');
    openSupportTicket(currentSupportTicketId);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function changeSupportStatus() {
  if (!currentSupportTicketId) return;
  const status = document.getElementById('support-modal-status').value;
  try {
    await apiCall('/admin/support/tickets/' + currentSupportTicketId + '/status', { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast('Statut mis à jour');
    loadSupportTickets();
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// CONFIGURATION & PARAMÈTRES
// ══════════════════════════════════════════════════════════════
let settingsCache = {};
let pendingConfigUpdates = {}; // stocke les updates en attente de confirmation

async function loadSettings() {
  try {
    const cfg = await apiCall('/admin/config');
    settingsCache = cfg;

    // Finances
    const cr = cfg['commission_rate'];
    if (cr) {
      const input = document.getElementById('cfg-commission-rate');
      input.value = parseFloat(cr.value) * 100;
      input.disabled = cr.readonly || false;
      document.getElementById('cfg-commission-desc').textContent = cr.description || '';
    }

    // Abonnements — readonly check
    ['price_essentiel','price_pro','price_elite'].forEach(k => {
      const id = 'cfg-price-' + k.replace('price_','');
      const el = document.getElementById(id);
      if (cfg[k] && el) { el.value = cfg[k].value; el.disabled = cfg[k].readonly || false; }
    });

    // Limites
    if (cfg['trial_days']) document.getElementById('cfg-trial-days').value = cfg['trial_days'].value;
    if (cfg['max_quotes_essentiel']) document.getElementById('cfg-max-quotes-essentiel').value = cfg['max_quotes_essentiel'].value;
    if (cfg['max_trades_essentiel']) document.getElementById('cfg-max-trades-essentiel').value = cfg['max_trades_essentiel'].value;
    if (cfg['max_trades_premium']) document.getElementById('cfg-max-trades-premium').value = cfg['max_trades_premium'].value;
    if (cfg['intervention_radius_km']) document.getElementById('cfg-intervention-radius').value = cfg['intervention_radius_km'].value;

    // Application — readonly : input désactivé + cadenas visible
    const appNameEl = document.getElementById('cfg-app-name');
    const supportEmailEl = document.getElementById('cfg-support-email');
    if (cfg['app_name']) { appNameEl.value = cfg['app_name'].value; appNameEl.disabled = cfg['app_name'].readonly || false; }
    if (cfg['support_email']) { supportEmailEl.value = cfg['support_email'].value; supportEmailEl.disabled = cfg['support_email'].readonly || false; }
    if (cfg['app_maintenance_mode']) {
      const el = document.getElementById('cfg-maintenance-mode');
      el.value = cfg['app_maintenance_mode'].value;
      el.disabled = cfg['app_maintenance_mode'].readonly || false;
    }

    // Badges readonly sur la carte Application
    document.getElementById('cfg-app-name-badge').style.display = cfg['app_name']?.readonly ? '' : 'none';
    document.getElementById('cfg-support-email-badge').style.display = cfg['support_email']?.readonly ? '' : 'none';

    // Tableau
    const tbody = document.getElementById('cfg-table-body');
    tbody.innerHTML = Object.entries(cfg).map(([key, v]) => {
      const val = key === 'commission_rate' ? (parseFloat(v.value) * 100).toFixed(1) + '%' : escHtml(v.value);
      const maint = key === 'app_maintenance_mode' && v.value === 'true';
      const roTag = v.readonly ? '<span style="background:var(--dark4);color:var(--muted);font-size:10px;padding:2px 7px;border-radius:6px;margin-left:6px;">🔒 lecture seule</span>' : '';
      const confTag = v.requiresConfirmation ? '<span style="background:var(--yellow-dim);color:var(--yellow);font-size:10px;padding:2px 7px;border-radius:6px;margin-left:4px;">🔑 confirmation</span>' : '';
      return '<tr>' +
        '<td><code style="color:var(--orange);font-size:12px;">' + escHtml(key) + '</code>' + roTag + confTag + '</td>' +
        '<td><strong style="color:' + (maint ? 'var(--red)' : 'var(--white)') + ';">' + val + '</strong></td>' +
        '<td style="color:var(--muted);font-size:12px;">' + escHtml(v.description || '') + '</td>' +
        '<td style="font-size:11px;color:var(--muted);">' + (v.updatedBy ? v.updatedBy.substring(0, 8) + '…' : '—') + '</td>' +
        '<td style="font-size:11px;color:var(--muted);">' + (v.updatedAt ? formatDate(v.updatedAt) : '—') + '</td>' +
        '</tr>';
    }).join('');
  } catch (err) {
    showToast('Erreur chargement config: ' + err.message, true);
  }
}

function buildUpdates(section) {
  const updates = {};
  if (section === 'finances') {
    const val = parseFloat(document.getElementById('cfg-commission-rate').value);
    if (isNaN(val) || val < 0 || val > 50) { showToast('Taux invalide (0–50%)', true); return null; }
    updates['commission_rate'] = (val / 100).toFixed(4);
  }
  if (section === 'abonnements') {
    updates['price_essentiel'] = parseInt(document.getElementById('cfg-price-essentiel').value) || 2500;
    updates['price_pro'] = parseInt(document.getElementById('cfg-price-pro').value) || 5000;
    updates['price_elite'] = parseInt(document.getElementById('cfg-price-elite').value) || 10000;
  }
  if (section === 'limites') {
    updates['trial_days'] = parseInt(document.getElementById('cfg-trial-days').value) || 14;
    updates['max_quotes_essentiel'] = parseInt(document.getElementById('cfg-max-quotes-essentiel').value) || 20;
    updates['max_trades_essentiel'] = parseInt(document.getElementById('cfg-max-trades-essentiel').value) || 3;
    updates['max_trades_premium'] = parseInt(document.getElementById('cfg-max-trades-premium').value) || 6;
    updates['intervention_radius_km'] = parseInt(document.getElementById('cfg-intervention-radius').value) || 30;
  }
  if (section === 'application') {
    const maintenance = document.getElementById('cfg-maintenance-mode').value;
    updates['app_maintenance_mode'] = maintenance;
  }
  return updates;
}

function needsConfirmation(updates) {
  return Object.keys(updates).some(k => settingsCache[k]?.requiresConfirmation);
}

function saveConfig(section) {
  const updates = buildUpdates(section);
  if (!updates || Object.keys(updates).length === 0) return;

  if (needsConfirmation(updates)) {
    // Afficher le modal de confirmation
    pendingConfigUpdates = updates;
    document.getElementById('cfg-confirm-error').style.display = 'none';
    document.getElementById('cfg-confirm-password').value = '';
    const keys = Object.keys(updates).join(', ');
    document.getElementById('cfg-confirm-keys').textContent = keys;
    document.getElementById('modal-cfg-confirm').classList.add('show');
  } else {
    doSaveConfig(updates, null);
  }
}

async function confirmSaveConfig() {
  const password = document.getElementById('cfg-confirm-password').value;
  if (!password) {
    document.getElementById('cfg-confirm-error').textContent = 'Mot de passe requis.';
    document.getElementById('cfg-confirm-error').style.display = 'block';
    return;
  }
  const btn = document.getElementById('cfg-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Vérification...';
  try {
    await doSaveConfig(pendingConfigUpdates, password);
    closeModal('modal-cfg-confirm');
    pendingConfigUpdates = {};
  } catch (err) {
    document.getElementById('cfg-confirm-error').textContent = err.message || 'Erreur';
    document.getElementById('cfg-confirm-error').style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmer';
  }
}

async function doSaveConfig(updates, confirmPassword) {
  const body = confirmPassword ? { ...updates, confirmPassword } : updates;
  try {
    await apiCall('/admin/config', { method: 'PATCH', body: JSON.stringify(body) });
    showToast('✅ Paramètres enregistrés');
    loadSettings();
  } catch (err) {
    // Si le serveur indique requiresConfirmation mais qu'on en est pas passé par le modal
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════
// AVIS & NOTATION
// ══════════════════════════════════════════════════════════════
let revCurrentPage = 1;
let revDebounceTimer = null;
let currentReviewId = null;
let currentReviewFlagged = false;

async function loadReviewStats() {
  try {
    const data = await apiCall('/admin/reviews/stats');
    document.getElementById('rev-total').textContent = data.total;
    document.getElementById('rev-avg').textContent = data.averageRating + ' / 5';
    document.getElementById('rev-satisfaction').textContent = data.satisfactionRate + '%';
    document.getElementById('rev-flagged').textContent = data.flagged;

    // Badge dans la nav
    const badge = document.getElementById('badge-reviews');
    if (data.flagged > 0) {
      badge.textContent = data.flagged;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }

    // Distribution
    const distEl = document.getElementById('rev-distribution');
    const max = Math.max(...data.distribution.map(d => d.count), 1);
    distEl.innerHTML = data.distribution.slice().reverse().map(d => {
      const pct = Math.round((d.count / max) * 100);
      const stars = '⭐'.repeat(d.rating);
      return '<div style="display:flex;align-items:center;gap:12px;">' +
        '<span style="font-size:12px;width:80px;color:var(--muted);">' + stars + '</span>' +
        '<div style="flex:1;background:var(--dark4);border-radius:6px;height:10px;overflow:hidden;">' +
        '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--orange),var(--gold));border-radius:6px;transition:width .5s;"></div>' +
        '</div>' +
        '<span style="font-size:12px;color:var(--white);font-weight:600;min-width:30px;text-align:right;">' + d.count + '</span>' +
        '</div>';
    }).join('');
  } catch (err) {
    showToast('Erreur chargement stats avis', true);
  }
}

async function loadReviews(page) {
  revCurrentPage = page || 1;
  const search = document.getElementById('rev-search').value.trim();
  const rating = document.getElementById('rev-rating-filter').value;
  const flagged = document.getElementById('rev-flagged-filter').value;

  let url = '/admin/reviews?page=' + revCurrentPage;
  if (search) url += '&search=' + encodeURIComponent(search);
  if (rating) url += '&rating=' + rating;
  if (flagged) url += '&flagged=' + flagged;

  const tbody = document.getElementById('rev-tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted);">Chargement...</td></tr>';

  try {
    const data = await apiCall(url);
    if (!data.reviews.length) {
      tbody.innerHTML = '';
      document.getElementById('rev-empty').style.display = '';
      document.getElementById('rev-pagination').innerHTML = '';
      return;
    }
    document.getElementById('rev-empty').style.display = 'none';

    tbody.innerHTML = data.reviews.map(r => {
      const stars = '⭐'.repeat(r.rating) + (r.rating < 5 ? '<span style="color:var(--dark4);">' + '⭐'.repeat(5 - r.rating) + '</span>' : '');
      const author = escHtml((r.author.firstName || '') + ' ' + (r.author.lastName || ''));
      const pro = r.professional ? escHtml((r.professional.user.firstName || '') + ' ' + (r.professional.user.lastName || '')) : '—';
      const comment = r.comment ? (r.comment.length > 60 ? escHtml(r.comment.substring(0, 60)) + '…' : escHtml(r.comment)) : '<span style="color:var(--muted);">Sans commentaire</span>';
      const project = r.project ? escHtml(r.project.title.substring(0, 30)) : '—';
      const flagCount = r.flags.length;
      const flagBadge = flagCount > 0 ? '<span style="background:var(--red-dim);color:var(--red);padding:2px 8px;border-radius:8px;font-size:11px;font-weight:700;">🚩 ' + flagCount + '</span>' : '—';
      const isFlagged = flagCount > 0;

      return '<tr>' +
        '<td>' + stars + '</td>' +
        '<td><span style="color:var(--white);">' + author + '</span><br><span style="font-size:11px;color:var(--muted);">' + escHtml(r.author.email) + '</span></td>' +
        '<td><span style="color:var(--orange);">' + pro + '</span><br><span style="font-size:11px;color:var(--muted);">' + (r.professional ? r.professional.averageRating + '★ (' + r.professional.reviewCount + ' avis)' : '') + '</span></td>' +
        '<td style="max-width:200px;">' + comment + '</td>' +
        '<td>' + project + '</td>' +
        '<td>' + flagBadge + '</td>' +
        '<td>' + formatDate(r.createdAt) + '</td>' +
        '<td><button class="btn btn-view" style="padding:6px 12px;font-size:12px;" onclick="openReviewModal(\'' + r.id + '\',' + isFlagged + ')">Voir</button></td>' +
        '</tr>';
    }).join('');

    // Pagination
    const pgEl = document.getElementById('rev-pagination');
    if (data.pages > 1) {
      pgEl.innerHTML = '<div class="pagination">' +
        '<button class="btn btn-view" onclick="loadReviews(' + (revCurrentPage - 1) + ')" ' + (revCurrentPage <= 1 ? 'disabled' : '') + '>← Préc</button>' +
        '<span class="page-info">Page ' + revCurrentPage + ' / ' + data.pages + ' (' + data.total + ' avis)</span>' +
        '<button class="btn btn-view" onclick="loadReviews(' + (revCurrentPage + 1) + ')" ' + (revCurrentPage >= data.pages ? 'disabled' : '') + '>Suiv →</button>' +
        '</div>';
    } else {
      pgEl.innerHTML = '<div class="pagination"><span class="page-info">' + data.total + ' avis</span></div>';
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--red);text-align:center;padding:24px;">Erreur: ' + escHtml(err.message) + '</td></tr>';
  }
}

function debounceRevSearch() {
  clearTimeout(revDebounceTimer);
  revDebounceTimer = setTimeout(() => loadReviews(1), 350);
}

async function openReviewModal(reviewId, isFlagged) {
  currentReviewId = reviewId;
  currentReviewFlagged = isFlagged;
  try {
    // Chercher dans les données déjà chargées pour afficher le détail complet
    const data = await apiCall('/admin/reviews?page=1&search=');
    // On re-fetch avec l'ID spécifique via la liste
    const url = '/admin/reviews?page=1';
    // Fetch all pages until found — use a direct approach: reload with no filter then find
    // Simpler: reload the current list and find
    const allData = await apiCall('/admin/reviews?page=' + revCurrentPage +
      (document.getElementById('rev-search').value ? '&search=' + encodeURIComponent(document.getElementById('rev-search').value) : '') +
      (document.getElementById('rev-rating-filter').value ? '&rating=' + document.getElementById('rev-rating-filter').value : '') +
      (document.getElementById('rev-flagged-filter').value ? '&flagged=' + document.getElementById('rev-flagged-filter').value : ''));
    const r = allData.reviews.find(x => x.id === reviewId);
    if (!r) { showToast('Avis introuvable', true); return; }

    document.getElementById('rev-modal-title').textContent = '⭐'.repeat(r.rating) + ' Avis de ' + (r.author.firstName || '') + ' ' + (r.author.lastName || '');

    const flagHtml = r.flags.length > 0
      ? '<div style="background:var(--red-dim);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:10px;margin-top:12px;">' +
        '<p style="color:var(--red);font-size:12px;font-weight:600;">🚩 ' + r.flags.length + ' signalement(s)</p>' +
        r.flags.map(f => '<p style="font-size:11px;color:var(--muted);margin-top:4px;">• ' + escHtml(f.reason || 'sans motif') + ' — par ' + escHtml(f.flaggedBy) + ' le ' + formatDate(f.createdAt) + '</p>').join('') +
        '</div>'
      : '';

    document.getElementById('rev-modal-body').innerHTML =
      '<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">' +
          '<div>' +
            '<p style="font-weight:600;color:var(--white);">👤 ' + escHtml((r.author.firstName || '') + ' ' + (r.author.lastName || '')) + '</p>' +
            '<p style="font-size:11px;color:var(--muted);">' + escHtml(r.author.email) + '</p>' +
          '</div>' +
          '<span style="font-size:20px;">' + '⭐'.repeat(r.rating) + '</span>' +
        '</div>' +
        (r.comment ? '<p style="font-size:14px;color:var(--light);line-height:1.6;font-style:italic;">«' + escHtml(r.comment) + '»</p>' : '<p style="color:var(--muted);font-size:13px;">Sans commentaire</p>') +
        '<p style="font-size:11px;color:var(--muted);margin-top:8px;">' + formatDate(r.createdAt) + '</p>' +
      '</div>' +
      '<p style="font-size:13px;color:var(--muted);margin-bottom:4px;">Professionnel évalué :</p>' +
      '<p style="font-size:14px;color:var(--orange);">' + (r.professional ? escHtml((r.professional.user.firstName || '') + ' ' + (r.professional.user.lastName || '')) + ' — ' + r.professional.averageRating + '★ (' + r.professional.reviewCount + ' avis)' : '—') + '</p>' +
      (r.project ? '<p style="font-size:13px;color:var(--muted);margin-top:8px;">Projet : <span style="color:var(--white);">' + escHtml(r.project.title) + '</span></p>' : '') +
      flagHtml;

    // Bouton flag
    const flagBtn = document.getElementById('rev-modal-flag-btn');
    if (r.flags.length > 0) {
      flagBtn.textContent = '✅ Retirer flag';
      flagBtn.style.background = 'var(--green-dim)';
      flagBtn.style.color = 'var(--green)';
      flagBtn.style.border = '1px solid rgba(34,197,94,0.3)';
    } else {
      flagBtn.textContent = '🚩 Signaler';
      flagBtn.style.background = 'var(--yellow-dim)';
      flagBtn.style.color = 'var(--yellow)';
      flagBtn.style.border = '1px solid rgba(245,158,11,0.3)';
    }

    document.getElementById('modal-review').classList.add('show');
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function reviewModalFlag() {
  if (!currentReviewId) return;
  const action = currentReviewFlagged ? 'remove' : 'add';
  try {
    await apiCall('/admin/reviews/' + currentReviewId + '/flag', { method: 'PATCH', body: JSON.stringify({ action, reason: 'admin_manual' }) });
    showToast(action === 'add' ? 'Avis signalé' : 'Signalement retiré');
    closeModal('modal-review');
    loadReviewStats();
    loadReviews(revCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

async function reviewModalDelete() {
  if (!currentReviewId) return;
  if (!confirm('Supprimer définitivement cet avis ? La note du professionnel sera recalculée.')) return;
  try {
    await apiCall('/admin/reviews/' + currentReviewId, { method: 'DELETE' });
    showToast('Avis supprimé et notes recalculées');
    closeModal('modal-review');
    loadReviewStats();
    loadReviews(revCurrentPage);
  } catch (err) {
    showToast('Erreur: ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// CRÉER UN ADMIN
// ══════════════════════════════════════════════════════════════
function resetCreateAdminForm() {
  ['new-admin-firstname','new-admin-lastname','new-admin-email','new-admin-password'].forEach(id => {
    document.getElementById(id).value = '';
  });
  const err = document.getElementById('create-admin-error');
  err.style.display = 'none';
  document.getElementById('create-admin-btn').disabled = false;
}

async function submitCreateAdmin() {
  const firstName = document.getElementById('new-admin-firstname').value.trim();
  const lastName  = document.getElementById('new-admin-lastname').value.trim();
  const email     = document.getElementById('new-admin-email').value.trim();
  const password  = document.getElementById('new-admin-password').value;
  const errEl     = document.getElementById('create-admin-error');
  const btn       = document.getElementById('create-admin-btn');

  errEl.style.display = 'none';
  if (!firstName || !lastName || !email || !password) {
    errEl.textContent = 'Tous les champs sont requis';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Création en cours...';
  try {
    await apiCall('/admin/create-admin', {
      method: 'POST',
      body: JSON.stringify({ firstName, lastName, email, password }),
    });
    showToast('Compte administrateur créé avec succès');
    resetCreateAdminForm();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Créer le compte administrateur';
  }
}

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════
(async function init() {
  // Vérifier le cookie httpOnly via l'API — aucune donnée sensible en localStorage
  try {
    const user = await apiCall('/admin/me');
    _adminUser = user;
    document.getElementById('admin-name').textContent = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
    document.getElementById('admin-email').textContent = user.email || '';
  } catch {
    window.location.href = '/admin/login.html';
    return;
  }
  loadDashboard();
  loadModerationStats();
  loadDisputeStats();
  loadSecurityStats();
  loadReviewStats();
})();

// ══════════════════════════════════════════════════════════════
// GESTION DES DEVIS
// ══════════════════════════════════════════════════════════════
let qaCurrentPage = 1;
let qaSearchTimer = null;
let _currentQuoteId = null;

const QA_STATUS_COLORS = {
  PENDING:  { badge: 'badge-yellow', label: '⏳ En attente' },
  ACCEPTED: { badge: 'badge-green',  label: '✅ Accepté'    },
  REFUSED:  { badge: 'badge-red',    label: '✕ Refusé'     },
  EXPIRED:  { badge: 'badge-muted',  label: '⏰ Expiré'    },
  REVISED:  { badge: 'badge-blue',   label: '🔄 Révisé'    },
};

async function loadQuoteStats() {
  try {
    const s = await apiCall('/admin/quotes/stats');

    document.getElementById('qa-kpi-total').textContent    = s.total ?? '--';
    document.getElementById('qa-kpi-accepted').textContent = s.accepted ?? '--';
    document.getElementById('qa-kpi-rate').textContent     = 'Taux d\'acceptation : ' + (s.acceptRate ?? '--') + '%';
    document.getElementById('qa-kpi-pending').textContent  = s.pending ?? '--';

    const amt = s.totalAmount || 0;
    document.getElementById('qa-kpi-amount').textContent =
      amt >= 1_000_000 ? (amt / 1_000_000).toFixed(1) + ' M FCFA'
      : amt >= 1_000   ? (amt / 1_000).toFixed(0)     + ' k FCFA'
      : amt + ' FCFA';

    // Barres statuts
    const statusBars = document.getElementById('qa-status-bars');
    const statuses = [
      { key: 'PENDING',  label: 'En attente', color: 'var(--yellow)', val: s.pending },
      { key: 'ACCEPTED', label: 'Acceptés',   color: 'var(--green)',  val: s.accepted },
      { key: 'REFUSED',  label: 'Refusés',    color: 'var(--red)',    val: s.refused },
      { key: 'EXPIRED',  label: 'Expirés',    color: 'var(--muted)',  val: s.expired },
      { key: 'REVISED',  label: 'Révisés',    color: 'var(--blue)',   val: s.revised },
    ];
    statusBars.innerHTML = statuses.map(st => {
      const pct = s.total > 0 ? Math.round((st.val / s.total) * 100) : 0;
      return `<div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
          <span style="color:var(--light);">${st.label}</span>
          <span style="color:var(--muted);">${st.val} (${pct}%)</span>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;">
          <div style="height:100%;width:${pct}%;background:${st.color};border-radius:3px;transition:width .5s;"></div>
        </div>
      </div>`;
    }).join('');

    // Barres mode
    const modeBars = document.getElementById('qa-mode-bars');
    modeBars.innerHTML = (s.byMode || []).map(m => {
      const pct = s.total > 0 ? Math.round((m.count / s.total) * 100) : 0;
      const color = m.mode === 'DETAILED' ? 'var(--orange)' : 'var(--blue)';
      return `<div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
          <span style="color:var(--light);">${m.mode === 'DETAILED' ? '📋 Détaillé' : '📄 Simple'}</span>
          <span style="color:var(--muted);">${m.count} (${pct}%)</span>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .5s;"></div>
        </div>
      </div>`;
    }).join('');

  } catch(e) {}
}

async function loadQuotes(page) {
  page = Math.max(1, page || 1);
  const search = document.getElementById('qa-search').value.trim();
  const status = document.getElementById('qa-status-filter').value;
  const mode   = document.getElementById('qa-mode-filter').value;
  const tbody  = document.getElementById('qa-tbody');
  const empty  = document.getElementById('qa-empty');
  const pag    = document.getElementById('qa-pagination');
  tbody.innerHTML = '<tr><td colspan="9"><div class="loading-spinner"></div></td></tr>';

  try {
    let url = '/admin/quotes?page=' + page;
    if (search) url += '&search=' + encodeURIComponent(search);
    if (status) url += '&status=' + status;
    if (mode)   url += '&mode='   + mode;

    const data = await apiCall(url);
    qaCurrentPage = data.page;
    tbody.innerHTML = '';

    if (!data.quotes || data.quotes.length === 0) {
      empty.style.display = '';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    data.quotes.forEach(q => {
      const proName = q.professional
        ? (q.professional.companyName || q.professional.user.firstName + ' ' + q.professional.user.lastName)
        : '—';
      const clientName = q.project?.client
        ? q.project.client.firstName + ' ' + q.project.client.lastName
        : '—';

      const st = QA_STATUS_COLORS[q.status] || { badge: 'badge-muted', label: q.status };
      const modeBadge = q.mode === 'DETAILED'
        ? '<span class="badge badge-orange" style="font-size:10px;">Détaillé</span>'
        : '<span class="badge badge-blue"   style="font-size:10px;">Simple</span>';
      const vBadge = q.version > 1 ? `<span class="badge badge-muted" style="font-size:9px;margin-left:4px;">v${q.version}</span>` : '';

      // Paiement le plus avancé
      let payBadge = '<span style="font-size:11px;color:var(--muted);">—</span>';
      if (q.payments && q.payments.length > 0) {
        const paid = q.payments.find(p => p.status === 'succeeded');
        const pend = q.payments.find(p => p.status === 'pending');
        if (paid)      payBadge = '<span class="badge badge-green"  style="font-size:10px;">✓ Payé</span>';
        else if (pend) payBadge = '<span class="badge badge-yellow" style="font-size:10px;">⏳ En attente</span>';
        else           payBadge = '<span class="badge badge-red"    style="font-size:10px;">✕ Échoué</span>';
      }

      tbody.innerHTML += `<tr>
        <td>
          <strong>${escHtml(proName)}</strong><br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(q.professional?.trade || '')}</span>
        </td>
        <td>
          <strong>${escHtml(clientName)}</strong><br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(q.project?.client?.email || '')}</span>
        </td>
        <td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${escHtml(q.project?.title || '—')}<br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(q.project?.city || '')}</span>
        </td>
        <td style="font-weight:700;color:var(--white);white-space:nowrap;">
          ${(q.amount || 0).toLocaleString('fr-FR')} FCFA${vBadge}
        </td>
        <td>${modeBadge}</td>
        <td><span class="badge ${st.badge}">${st.label}</span></td>
        <td>${payBadge}</td>
        <td style="font-size:11px;color:var(--muted);">${new Date(q.createdAt).toLocaleDateString('fr-FR')}</td>
        <td class="td-actions">
          <button class="btn btn-view" onclick="openQuoteDetail('${q.id}')">🔍 Voir</button>
        </td>
      </tr>`;
    });

    pag.style.display = data.pages > 1 ? 'flex' : 'none';
    document.getElementById('qa-page-info').textContent = 'Page ' + data.page + ' / ' + data.pages + ' — ' + data.total + ' devis';
    document.getElementById('qa-prev').disabled = data.page <= 1;
    document.getElementById('qa-next').disabled = data.page >= data.pages;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--red);">Erreur de chargement</td></tr>';
  }
}

function debounceQuotes() {
  clearTimeout(qaSearchTimer);
  qaSearchTimer = setTimeout(() => loadQuotes(1), 350);
}

async function openQuoteDetail(quoteId) {
  _currentQuoteId = quoteId;
  document.getElementById('modal-quote-detail').classList.add('show');
  document.getElementById('qd-title').textContent = 'Chargement…';
  document.getElementById('qd-meta').textContent  = '';
  document.getElementById('qd-parties').innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById('qd-project-card').innerHTML = '';
  document.getElementById('qd-items-tbody').innerHTML  = '';
  document.getElementById('qd-items-total').innerHTML  = '';
  document.getElementById('qd-items-empty').style.display = 'none';
  document.getElementById('qd-payments-section').style.display   = 'none';
  document.getElementById('qd-revisions-section').style.display  = 'none';
  document.getElementById('qd-cancel-btn').style.display = 'none';
  document.getElementById('qd-pdf-btn').style.display    = 'none';

  try {
    const q = await apiCall('/admin/quotes/' + quoteId);

    const st = QA_STATUS_COLORS[q.status] || { badge: 'badge-muted', label: q.status };
    const proName = q.professional
      ? (q.professional.companyName || q.professional.user.firstName + ' ' + q.professional.user.lastName)
      : '—';

    document.getElementById('qd-title').textContent =
      '📄 Devis — ' + proName + (q.version > 1 ? ' (v' + q.version + ')' : '');
    document.getElementById('qd-meta').innerHTML =
      `<span class="badge ${st.badge}">${st.label}</span>` +
      ` &nbsp;•&nbsp; ${new Date(q.createdAt).toLocaleDateString('fr-FR')}` +
      (q.expiresAt ? ` &nbsp;•&nbsp; Expire le ${new Date(q.expiresAt).toLocaleDateString('fr-FR')}` : '');

    // Bouton expirer
    if (['PENDING', 'REVISED'].includes(q.status)) {
      document.getElementById('qd-cancel-btn').style.display = '';
    }
    // Bouton PDF — toujours affiché, pointe vers le stream backend
    {
      const pdfBtn = document.getElementById('qd-pdf-btn');
      pdfBtn.href = API_BASE + '/quotes/' + q.id + '/pdf?stream=1';
      pdfBtn.style.display = '';
    }

    // Parties : pro + client
    const pro = q.professional || {};
    const client = q.project?.client || {};
    document.getElementById('qd-parties').innerHTML = `
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px;letter-spacing:1px;">PROFESSIONNEL</div>
        <div style="font-weight:700;font-size:15px;margin-bottom:2px;">${escHtml(proName)}</div>
        <div style="font-size:12px;color:var(--muted);">${escHtml(pro.trade || '')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">${escHtml(pro.user?.email || '')}</div>
        <div style="font-size:12px;color:var(--muted);">${escHtml(pro.user?.phone || '')}</div>
        ${pro.averageRating > 0 ? `<div style="font-size:12px;color:var(--gold);margin-top:4px;">⭐ ${pro.averageRating.toFixed(1)}</div>` : ''}
      </div>
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px;letter-spacing:1px;">CLIENT</div>
        <div style="font-weight:700;font-size:15px;margin-bottom:2px;">${escHtml(client.firstName + ' ' + client.lastName)}</div>
        <div style="font-size:12px;color:var(--muted);">${escHtml(client.email || '')}</div>
        <div style="font-size:12px;color:var(--muted);">${escHtml(client.phone || '')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">${escHtml(client.city || '')}</div>
      </div>`;

    // Projet
    const proj = q.project || {};
    document.getElementById('qd-project-card').innerHTML = `
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px;letter-spacing:1px;">PROJET</div>
      <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${escHtml(proj.title || '—')}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);">
        <span>📍 ${escHtml(proj.city || '—')}</span>
        <span>🔧 ${escHtml(proj.tradeNeeded || '—')}</span>
        <span>${proj.status ? '● ' + proj.status : ''}</span>
      </div>
      ${proj.description ? `<div style="font-size:12px;color:var(--light);margin-top:8px;">${escHtml(proj.description)}</div>` : ''}`;

    // Mode badge
    document.getElementById('qd-mode-badge').innerHTML = q.mode === 'DETAILED'
      ? '<span class="badge badge-orange">📋 Détaillé</span>'
      : '<span class="badge badge-blue">📄 Simple</span>';

    // Lignes
    if (q.items && q.items.length > 0) {
      const catLabels = { LABOUR: 'Main-d\'œuvre', MATERIALS: 'Matériaux', OTHER: 'Autre' };
      const tbody = document.getElementById('qd-items-tbody');
      tbody.innerHTML = q.items.map(it => `<tr>
        <td><span class="badge badge-muted" style="font-size:10px;">${catLabels[it.category] || it.category}</span></td>
        <td>${escHtml(it.label)}</td>
        <td style="text-align:right;">${it.quantity}</td>
        <td style="color:var(--muted);">${escHtml(it.unit || '—')}</td>
        <td style="text-align:right;">${it.unitPrice.toLocaleString('fr-FR')} FCFA</td>
        <td style="text-align:right;font-weight:700;">${it.total.toLocaleString('fr-FR')} FCFA</td>
      </tr>`).join('');
      document.getElementById('qd-items-total').innerHTML = `
        <tr style="border-top:2px solid var(--border);">
          <td colspan="5" style="text-align:right;font-weight:600;color:var(--muted);padding:12px 16px;">TOTAL</td>
          <td style="text-align:right;font-weight:800;font-size:16px;color:var(--orange);padding:12px 16px;">
            ${q.amount.toLocaleString('fr-FR')} FCFA
          </td>
        </tr>`;
    } else {
      document.getElementById('qd-items-empty').style.display = '';
      document.getElementById('qd-items-total').innerHTML = `
        <tr style="border-top:2px solid var(--border);">
          <td colspan="5" style="text-align:right;font-weight:600;color:var(--muted);padding:12px 16px;">MONTANT GLOBAL</td>
          <td style="text-align:right;font-weight:800;font-size:16px;color:var(--orange);padding:12px 16px;">
            ${q.amount.toLocaleString('fr-FR')} FCFA
          </td>
        </tr>`;
    }

    // Paiements
    if (q.payments && q.payments.length > 0) {
      document.getElementById('qd-payments-section').style.display = '';
      const payColors = { succeeded: 'badge-green', pending: 'badge-yellow', failed: 'badge-red' };
      document.getElementById('qd-payments-tbody').innerHTML = q.payments.map(p => `<tr>
        <td>${p.isDeposit ? '🔒 Acompte' : '✅ Solde'}</td>
        <td style="font-weight:700;">${p.amount.toLocaleString('fr-FR')} FCFA</td>
        <td><span class="badge ${payColors[p.status] || 'badge-muted'}">${p.status}</span></td>
        <td style="color:var(--muted);font-size:12px;">${escHtml(p.paymentMethod || '—')}</td>
        <td style="font-size:11px;color:var(--muted);">${p.completedAt ? new Date(p.completedAt).toLocaleDateString('fr-FR') : '—'}</td>
      </tr>`).join('');
    }

    // Révisions
    const allVersions = [
      ...(q.parentQuote ? [{ ...q.parentQuote, isCurrent: false }] : []),
      ...((q.revisions || []).map(r => ({ ...r, isCurrent: r.id === q.id }))),
    ];
    if (allVersions.length > 0) {
      document.getElementById('qd-revisions-section').style.display = '';
      document.getElementById('qd-revisions-tbody').innerHTML = allVersions.map(r => {
        const rst = QA_STATUS_COLORS[r.status] || { badge: 'badge-muted', label: r.status };
        const current = r.isCurrent ? ' style="background:rgba(244,114,11,0.05);"' : '';
        return `<tr${current}>
          <td><strong>v${r.version}</strong>${r.isCurrent ? ' <span class="badge badge-orange" style="font-size:9px;">actuel</span>' : ''}</td>
          <td style="font-weight:700;">${(r.amount || 0).toLocaleString('fr-FR')} FCFA</td>
          <td><span class="badge ${rst.badge}" style="font-size:10px;">${rst.label}</span></td>
          <td style="font-size:12px;color:var(--muted);max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.description || '—')}</td>
          <td style="font-size:11px;color:var(--muted);">${new Date(r.createdAt).toLocaleDateString('fr-FR')}</td>
          <td>${!r.isCurrent ? `<button class="btn btn-view" style="font-size:11px;padding:4px 10px;" onclick="openQuoteDetail('${r.id}')">Voir</button>` : ''}</td>
        </tr>`;
      }).join('');
    }

  } catch(e) {
    document.getElementById('qd-title').textContent = 'Erreur de chargement';
  }
}

async function cancelQuote() {
  if (!_currentQuoteId) return;
  if (!confirm('Expirer ce devis ? Il passera au statut EXPIRED.')) return;
  try {
    await apiCall('/admin/quotes/' + _currentQuoteId + '/cancel', { method: 'PATCH' });
    showToast('Devis expiré');
    closeModal('modal-quote-detail');
    loadQuotes(qaCurrentPage);
    loadQuoteStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS PUSH
// ══════════════════════════════════════════════════════════════
let pushTokPage = 1, pushHistPage = 1;
let pushTokTimer = null, pushHistTimer = null, pushUserTimer = null;
let _pushCurrentTab = 'tokens';

async function loadPushStats() {
  try {
    const s = await apiCall('/admin/notifications/stats');

    document.getElementById('push-kpi-active').textContent    = s.tokens.active ?? '--';
    document.getElementById('push-kpi-delivery').textContent  = 'Taux délivrance : ' + (s.tokens.deliveryRate ?? '--') + '%';
    document.getElementById('push-kpi-coverage').textContent  = (s.tokens.coverageRate ?? '--') + '%';
    document.getElementById('push-kpi-notifs30d').textContent = s.notifications.last30d ?? '--';
    document.getElementById('push-kpi-readrate').textContent  = (s.notifications.readRate ?? '--') + '%';

    // Barres plateforme
    const platEl = document.getElementById('push-platform-bars');
    const platTotal = s.tokens.byPlatform.reduce((a, r) => a + r.count, 0) || 1;
    platEl.innerHTML = s.tokens.byPlatform.length === 0
      ? '<span style="color:var(--muted);font-size:13px;">Aucun token enregistré</span>'
      : s.tokens.byPlatform.map(r => {
          const pct = Math.round((r.count / platTotal) * 100);
          const color = r.platform === 'iOS' ? 'var(--blue)' : 'var(--green)';
          return `<div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <span style="color:var(--light);">${escHtml(r.platform)}</span>
              <span style="color:var(--muted);">${r.count} (${pct}%)</span>
            </div>
            <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;">
              <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .5s;"></div>
            </div>
          </div>`;
        }).join('');

    // Barres type
    const typeEl = document.getElementById('push-type-bars');
    const typeTotal = s.tokens.byType.reduce((a, r) => a + r.count, 0) || 1;
    const typeColors = { FCM: 'var(--orange)', EXPO: 'var(--gold)', APNs: 'var(--blue)' };
    typeEl.innerHTML = s.tokens.byType.length === 0
      ? '<span style="color:var(--muted);font-size:13px;">Aucun token enregistré</span>'
      : s.tokens.byType.map(r => {
          const pct = Math.round((r.count / typeTotal) * 100);
          const color = typeColors[r.type] || 'var(--muted)';
          return `<div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <span style="color:var(--light);">${escHtml(r.type)}</span>
              <span style="color:var(--muted);">${r.count} (${pct}%)</span>
            </div>
            <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;">
              <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .5s;"></div>
            </div>
          </div>`;
        }).join('');
  } catch(e) {}
}

function switchPushTab(tab) {
  _pushCurrentTab = tab;
  document.getElementById('push-panel-tokens').style.display  = tab === 'tokens'  ? '' : 'none';
  document.getElementById('push-panel-history').style.display = tab === 'history' ? '' : 'none';
  document.getElementById('push-tab-tokens').className  = 'btn ' + (tab === 'tokens'  ? 'btn-approve' : 'btn-view');
  document.getElementById('push-tab-history').className = 'btn ' + (tab === 'history' ? 'btn-approve' : 'btn-view');
  if (tab === 'history' && pushHistPage === 1) loadPushHistory(1);
}

// ─── Tokens ────────────────────────────────────────────────────────────────

async function loadPushTokens(page) {
  page = Math.max(1, page || 1);
  const search   = document.getElementById('push-tok-search').value.trim();
  const platform = document.getElementById('push-tok-platform').value;
  const type     = document.getElementById('push-tok-type').value;
  const active   = document.getElementById('push-tok-active').value;
  const tbody    = document.getElementById('push-tok-tbody');
  const empty    = document.getElementById('push-tok-empty');
  const pag      = document.getElementById('push-tok-pagination');
  tbody.innerHTML = '<tr><td colspan="8"><div class="loading-spinner"></div></td></tr>';

  try {
    let url = '/admin/notifications/tokens?page=' + page;
    if (search)   url += '&search='   + encodeURIComponent(search);
    if (platform) url += '&platform=' + encodeURIComponent(platform);
    if (type)     url += '&type='     + encodeURIComponent(type);
    if (active)   url += '&active='   + active;

    const data = await apiCall(url);
    pushTokPage = data.page;
    tbody.innerHTML = '';

    if (!data.tokens || data.tokens.length === 0) {
      empty.style.display = '';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    data.tokens.forEach(t => {
      const uName  = t.user ? t.user.firstName + ' ' + t.user.lastName : '—';
      const uRole  = t.user?.role === 'PROFESSIONAL' ? '<span class="badge badge-orange" style="font-size:9px;">PRO</span>' : '<span class="badge badge-blue" style="font-size:9px;">CLIENT</span>';
      const platIcon = t.platform === 'iOS' ? '🍎' : '🤖';
      const typeColor = { FCM: 'badge-orange', EXPO: 'badge-yellow', APNs: 'badge-blue' }[t.type] || 'badge-muted';
      const statusBadge = t.isActive ? '<span class="badge badge-green">● Actif</span>' : '<span class="badge badge-muted">Inactif</span>';
      const lastUsed = t.lastUsed ? new Date(t.lastUsed).toLocaleDateString('fr-FR') : '—';
      const shortToken = t.token ? (t.token.substring(0, 18) + '…') : '—';

      tbody.innerHTML += `<tr>
        <td>
          <strong>${escHtml(uName)}</strong> ${uRole}<br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(t.user?.email || '')}</span>
        </td>
        <td>${platIcon} ${escHtml(t.platform)}</td>
        <td><span class="badge ${typeColor}">${escHtml(t.type)}</span></td>
        <td style="font-size:11px;color:var(--muted);">${escHtml(t.deviceId || '—')}</td>
        <td style="font-size:12px;">${lastUsed}</td>
        <td style="font-size:11px;color:var(--muted);">${new Date(t.createdAt).toLocaleDateString('fr-FR')}</td>
        <td>${statusBadge}</td>
        <td class="td-actions">
          ${t.user ? `<button class="btn btn-approve" style="font-size:11px;padding:5px 10px;" onclick="openSendPushModal('${t.user.id}','${escHtml(uName)}')">📤</button>` : ''}
          ${t.isActive ? `<button class="btn btn-reject" style="font-size:11px;padding:5px 10px;" onclick="invalidateToken('${t.id}')">⛔</button>` : ''}
        </td>
      </tr>`;
    });

    pag.style.display = data.pages > 1 ? 'flex' : 'none';
    document.getElementById('push-tok-page-info').textContent = 'Page ' + data.page + ' / ' + data.pages + ' — ' + data.total + ' token(s)';
    document.getElementById('push-tok-prev').disabled = data.page <= 1;
    document.getElementById('push-tok-next').disabled = data.page >= data.pages;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--red);">Erreur de chargement</td></tr>';
  }
}

function debouncePushTokens() {
  clearTimeout(pushTokTimer);
  pushTokTimer = setTimeout(() => loadPushTokens(1), 350);
}

async function invalidateToken(tokenId) {
  if (!confirm('Invalider ce token ? L\'appareil ne recevra plus de notifications.')) return;
  try {
    await apiCall('/admin/notifications/tokens/' + tokenId, { method: 'DELETE' });
    showToast('Token invalidé');
    loadPushTokens(pushTokPage);
    loadPushStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

// ─── Historique ────────────────────────────────────────────────────────────

async function loadPushHistory(page) {
  page = Math.max(1, page || 1);
  const userId = document.getElementById('push-hist-user').value.trim();
  const read   = document.getElementById('push-hist-read').value;
  const tbody  = document.getElementById('push-hist-tbody');
  const empty  = document.getElementById('push-hist-empty');
  const pag    = document.getElementById('push-hist-pagination');
  tbody.innerHTML = '<tr><td colspan="6"><div class="loading-spinner"></div></td></tr>';

  try {
    let url = '/admin/notifications/history?page=' + page;
    if (userId) url += '&userId=' + encodeURIComponent(userId);
    if (read)   url += '&read='   + read;

    const data = await apiCall(url);
    pushHistPage = data.page;
    tbody.innerHTML = '';

    if (!data.notifications || data.notifications.length === 0) {
      empty.style.display = '';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    data.notifications.forEach(n => {
      const uName = n.user ? n.user.firstName + ' ' + n.user.lastName : '—';
      const readBadge = n.read
        ? '<span class="badge badge-green" style="font-size:10px;">✓ Lue</span>'
        : '<span class="badge badge-yellow" style="font-size:10px;">● Non lue</span>';
      const typeBadge = n.type ? `<span class="badge badge-muted" style="font-size:10px;">${escHtml(n.type)}</span>` : '';

      tbody.innerHTML += `<tr>
        <td>
          <strong>${escHtml(uName)}</strong><br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(n.user?.email || '')}</span>
        </td>
        <td><strong style="color:var(--white);">${escHtml(n.title || '—')}</strong></td>
        <td style="font-size:12px;color:var(--muted);max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(n.body || n.message || '—')}</td>
        <td>${typeBadge}</td>
        <td>${readBadge}</td>
        <td style="font-size:11px;color:var(--muted);">${new Date(n.createdAt).toLocaleDateString('fr-FR')}</td>
      </tr>`;
    });

    pag.style.display = data.pages > 1 ? 'flex' : 'none';
    document.getElementById('push-hist-page-info').textContent = 'Page ' + data.page + ' / ' + data.pages + ' — ' + data.total + ' notif(s)';
    document.getElementById('push-hist-prev').disabled = data.page <= 1;
    document.getElementById('push-hist-next').disabled = data.page >= data.pages;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--red);">Erreur de chargement</td></tr>';
  }
}

function debouncePushHistory() {
  clearTimeout(pushHistTimer);
  pushHistTimer = setTimeout(() => loadPushHistory(1), 400);
}

// ─── Envoi ciblé ───────────────────────────────────────────────────────────

function openSendPushModal(userId, userName) {
  document.getElementById('push-send-user-id').value     = userId || '';
  document.getElementById('push-send-user-search').value = userName || '';
  document.getElementById('push-send-user-results').style.display = 'none';
  document.getElementById('push-send-user-selected').style.display = userId ? '' : 'none';
  document.getElementById('push-send-user-selected').textContent  = userId ? ('✓ ' + userName) : '';
  document.getElementById('push-send-title').value  = '';
  document.getElementById('push-send-body').value   = '';
  document.getElementById('push-send-type').value   = 'ADMIN';
  document.getElementById('push-send-error').style.display  = 'none';
  document.getElementById('push-send-result').style.display = 'none';
  document.getElementById('push-send-btn').disabled = false;
  document.getElementById('push-send-btn').textContent = '📤 Envoyer';
  document.getElementById('modal-send-push').classList.add('show');
}

let _pushUserSearchTimer = null;
function debouncePushUserSearch() {
  clearTimeout(_pushUserSearchTimer);
  const q = document.getElementById('push-send-user-search').value.trim();
  if (q.length < 2) { document.getElementById('push-send-user-results').style.display = 'none'; return; }
  _pushUserSearchTimer = setTimeout(async () => {
    try {
      const res = await apiCall('/admin/professionals?search=' + encodeURIComponent(q) + '&limit=5');
      const clients = await apiCall('/admin/users?search=' + encodeURIComponent(q) + '&limit=5');
      const all = [
        ...(res.professionals || []).map(p => ({ id: p.userId, name: p.user.firstName + ' ' + p.user.lastName, email: p.user.email, role: 'PRO' })),
        ...(clients.users || []).filter(u => u.role === 'CLIENT').slice(0, 5).map(u => ({ id: u.id, name: u.firstName + ' ' + u.lastName, email: u.email, role: 'CLIENT' })),
      ].slice(0, 8);

      const box = document.getElementById('push-send-user-results');
      if (all.length === 0) { box.style.display = 'none'; return; }
      box.style.display = '';
      box.innerHTML = all.map(u =>
        `<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px;" onmousedown="selectPushUser('${u.id}','${escHtml(u.name + ' (' + u.email + ')')}')">
          <strong>${escHtml(u.name)}</strong> <span class="badge ${u.role === 'PRO' ? 'badge-orange' : 'badge-blue'}" style="font-size:9px;">${u.role}</span><br>
          <span style="color:var(--muted);font-size:11px;">${escHtml(u.email)}</span>
        </div>`
      ).join('');
    } catch(e) {}
  }, 300);
}

function selectPushUser(id, label) {
  document.getElementById('push-send-user-id').value = id;
  document.getElementById('push-send-user-search').value = label;
  document.getElementById('push-send-user-results').style.display = 'none';
  const sel = document.getElementById('push-send-user-selected');
  sel.textContent = '✓ ' + label;
  sel.style.display = '';
}

async function sendTargetedPush() {
  const errEl  = document.getElementById('push-send-error');
  const resEl  = document.getElementById('push-send-result');
  const btn    = document.getElementById('push-send-btn');
  errEl.style.display = 'none';
  resEl.style.display = 'none';

  const userId = document.getElementById('push-send-user-id').value.trim();
  const title  = document.getElementById('push-send-title').value.trim();
  const body   = document.getElementById('push-send-body').value.trim();
  const type   = document.getElementById('push-send-type').value;

  if (!userId) { errEl.textContent = 'Sélectionnez un utilisateur'; errEl.style.display = 'block'; return; }
  if (!title)  { errEl.textContent = 'Le titre est requis';          errEl.style.display = 'block'; return; }
  if (!body)   { errEl.textContent = 'Le message est requis';        errEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Envoi…';

  try {
    const r = await apiCall('/admin/notifications/send', {
      method: 'POST',
      body: JSON.stringify({ userId, title, body, type }),
    });

    const pushSent = r.push?.sent;
    const pushCount = r.push?.count ?? 0;
    resEl.innerHTML = pushSent
      ? `✅ Notification envoyée ! Push : ${pushCount} appareil(s) atteint(s).`
      : `⚠️ Notification enregistrée en DB mais aucun token push actif pour cet utilisateur.`;
    resEl.style.display = '';
    btn.textContent = '✓ Envoyé';

    loadPushStats();
    if (_pushCurrentTab === 'history') loadPushHistory(1);
  } catch(e) {
    errEl.textContent = e.message || 'Erreur lors de l\'envoi';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '📤 Envoyer';
  }
}

// ══════════════════════════════════════════════════════════════
// MESSAGERIE
// ══════════════════════════════════════════════════════════════
let msgConvPage = 1, msgConvTotal = 0, msgConvPages = 0;
let msgThreadUserA = null, msgThreadUserB = null, msgThreadPage = 1;
let msgSearchTimer = null;

async function loadMsgStats() {
  try {
    const d = await apiCall('/admin/messaging/stats');
    document.getElementById('msg-kpi-total').textContent  = d.total.toLocaleString();
    document.getElementById('msg-kpi-convs').textContent  = d.totalConversations.toLocaleString();
    document.getElementById('msg-kpi-active').textContent = d.activeConversations.toLocaleString();
    document.getElementById('msg-kpi-unread').textContent = d.unread.toLocaleString();
    document.getElementById('msg-kpi-7d').textContent     = d.last7d.toLocaleString();
    document.getElementById('msg-kpi-30d').textContent    = d.last30d.toLocaleString();

    const topEl = document.getElementById('msg-top-senders');
    if (d.topSenders && d.topSenders.length) {
      topEl.innerHTML = d.topSenders.map((s, i) => {
        const u = s.user || {};
        const name = u.firstName ? escHtml(u.firstName + ' ' + u.lastName) : '<span style="color:var(--muted)">Inconnu</span>';
        const badge = u.role === 'PROFESSIONAL'
          ? '<span class="badge badge-orange" style="font-size:9px;margin-left:4px;">Pro</span>'
          : '<span class="badge badge-blue" style="font-size:9px;margin-left:4px;">Client</span>';
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">
          <span>${i+1}. ${name}${badge}</span>
          <strong>${s.count}</strong>
        </div>`;
      }).join('');
    } else {
      topEl.innerHTML = '<span style="color:var(--muted);font-size:12px;">Aucune donnée</span>';
    }
  } catch (e) { showToast('Erreur stats messagerie', 'error'); }
}

async function loadMsgConversations(page) {
  if (page < 1) return;
  msgConvPage = page;
  const search = document.getElementById('msg-search')?.value.trim() || '';
  const params = new URLSearchParams({ page });
  if (search) params.set('search', search);
  try {
    const d = await apiCall('/admin/messaging/conversations?' + params);
    msgConvTotal = d.total;
    msgConvPages = d.pages;

    const tbody = document.getElementById('msg-conv-tbody');
    tbody.innerHTML = '';
    if (!d.conversations.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">Aucune conversation</td></tr>';
    } else {
      d.conversations.forEach(c => {
        const sName = c.sender ? escHtml(c.sender.firstName + ' ' + c.sender.lastName) : '?';
        const rName = c.receiver ? escHtml(c.receiver.firstName + ' ' + c.receiver.lastName) : '?';
        const sRole = c.sender?.role === 'PROFESSIONAL'
          ? '<span class="badge badge-orange" style="font-size:9px;">Pro</span>'
          : '<span class="badge badge-blue" style="font-size:9px;">Client</span>';
        const rRole = c.receiver?.role === 'PROFESSIONAL'
          ? '<span class="badge badge-orange" style="font-size:9px;">Pro</span>'
          : '<span class="badge badge-blue" style="font-size:9px;">Client</span>';
        const preview = c.content ? escHtml(c.content.substring(0, 60)) + (c.content.length > 60 ? '…' : '') : '—';
        const unreadBadge = c.unreadCount > 0
          ? `<span class="badge badge-red" style="font-size:10px;">${c.unreadCount}</span>`
          : '<span style="color:var(--muted)">0</span>';
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.onclick = () => openMsgThread(c.senderId, c.receiverId, sName, rName);
        tr.innerHTML = `
          <td><strong>${sName}</strong>${sRole}<br><span style="color:var(--muted);font-size:11px;">→</span> <strong>${rName}</strong>${rRole}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted);">${preview}</td>
          <td><strong>${c.msgCount || '?'}</strong></td>
          <td>${unreadBadge}</td>
          <td style="font-size:12px;color:var(--muted);">${formatDate(c.createdAt)}</td>
          <td class="td-actions">
            <button class="btn btn-view" onclick="event.stopPropagation();openMsgThread('${escAttr(c.senderId)}','${escAttr(c.receiverId)}','${escAttr(sName)}','${escAttr(rName)}')">💬 Voir</button>
          </td>`;
        tbody.appendChild(tr);
      });
    }

    const pi = document.getElementById('msg-page-info');
    if (pi) pi.textContent = `Page ${page} / ${msgConvPages || 1}`;
    const prev = document.getElementById('msg-prev');
    const next = document.getElementById('msg-next');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= msgConvPages;
  } catch (e) { showToast('Erreur chargement conversations', 'error'); }
}

function debounceMsgSearch(val) {
  clearTimeout(msgSearchTimer);
  msgSearchTimer = setTimeout(() => loadMsgConversations(1), 380);
}

async function openMsgThread(userA, userB, nameA, nameB) {
  msgThreadUserA = userA;
  msgThreadUserB = userB;
  msgThreadPage  = 1;
  const panel = document.getElementById('msg-thread-panel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('msg-thread-title').textContent = `Conversation : ${nameA} ↔ ${nameB}`;
  await loadMsgThread(userA, userB, 1);
}

function closeMsgThread() {
  document.getElementById('msg-thread-panel').style.display = 'none';
  msgThreadUserA = null; msgThreadUserB = null;
}

async function loadMsgThread(userA, userB, page) {
  if (page < 1) return;
  msgThreadPage = page;
  try {
    const d = await apiCall(`/api/admin/messaging/conversations/${encodeURIComponent(userA)}/${encodeURIComponent(userB)}?page=${page}`);
    const body = document.getElementById('msg-thread-body');
    body.innerHTML = '';

    if (!d.messages.length) {
      body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:24px;font-size:13px;">Aucun message</div>';
    } else {
      d.messages.forEach(m => {
        const isA = m.senderId === userA;
        const sender = isA ? d.userA : d.userB;
        const sName = sender ? escHtml(sender.firstName + ' ' + sender.lastName) : '?';
        const bubble = document.createElement('div');
        bubble.style.cssText = `display:flex;flex-direction:column;align-items:${isA ? 'flex-start' : 'flex-end'};max-width:75%;${isA ? '' : 'align-self:flex-end;'}`;
        bubble.innerHTML = `
          <div style="font-size:10px;color:var(--muted);margin-bottom:3px;${isA ? '' : 'text-align:right;'}">${sName} · ${formatDate(m.createdAt)}</div>
          <div style="background:${isA ? 'var(--card-hover,#2a2a3e)' : 'rgba(99,102,241,0.15)'};border-radius:${isA ? '4px 14px 14px 14px' : '14px 4px 14px 14px'};padding:8px 12px;font-size:13px;color:var(--text);word-break:break-word;position:relative;">
            ${escHtml(m.content)}
            <span style="font-size:9px;color:var(--muted);margin-left:6px;">${m.read ? '✓✓' : '✓'}</span>
            <button onclick="deleteMsgAdmin('${escAttr(m.id)}')" style="position:absolute;top:-6px;right:-6px;background:var(--red);border:none;border-radius:50%;width:16px;height:16px;font-size:9px;color:#fff;cursor:pointer;display:none;" class="msg-del-btn">✕</button>
          </div>`;
        bubble.querySelector('.msg-del-btn').style.display = 'none';
        bubble.onmouseenter = () => bubble.querySelector('.msg-del-btn').style.display = 'block';
        bubble.onmouseleave = () => bubble.querySelector('.msg-del-btn').style.display = 'none';
        body.appendChild(bubble);
      });
      body.scrollTop = body.scrollHeight;
    }

    const pages = Math.ceil(d.total / 50) || 1;
    const pi = document.getElementById('msg-thread-page-info');
    if (pi) pi.textContent = `Page ${page} / ${pages}`;
    const prev = document.getElementById('msg-thread-prev');
    const next = document.getElementById('msg-thread-next');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
  } catch (e) { showToast('Erreur chargement thread', 'error'); }
}

async function deleteMsgAdmin(msgId) {
  if (!confirm('Supprimer ce message définitivement ?')) return;
  try {
    await apiCall(`/api/admin/messaging/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
    showToast('Message supprimé');
    loadMsgThread(msgThreadUserA, msgThreadUserB, msgThreadPage);
    loadMsgConversations(msgConvPage);
  } catch (e) { showToast('Erreur suppression message', 'error'); }
}

// ══════════════════════════════════════════════════════════════
// CODES PROMO & OFFRES
// ══════════════════════════════════════════════════════════════
let promoCurrentPage = 1;
let promoSearchTimer = null;
let _editingPromoId = null;

async function loadPromoStats() {
  try {
    const s = await apiCall('/admin/promos/stats');
    document.getElementById('promo-total').textContent = s.total ?? '--';
    document.getElementById('promo-active').textContent = s.active ?? '--';
    document.getElementById('promo-usages').textContent = s.totalUsages ?? '--';
    document.getElementById('promo-expired').textContent = s.expired ?? '--';
    const topAlert = document.getElementById('promo-top-alert');
    if (s.topPromo && s.topPromo.usedCount > 0) {
      topAlert.innerHTML = '🏆 Code le plus utilisé : <strong>' + escHtml(s.topPromo.code) + '</strong>' +
        (s.topPromo.description ? ' — ' + escHtml(s.topPromo.description) : '') +
        ' · <strong>' + s.topPromo.usedCount + ' utilisations</strong>';
      topAlert.style.display = '';
    }
  } catch(e) {}
}

async function loadPromos(page) {
  page = Math.max(1, page || 1);
  const search = document.getElementById('promo-search').value.trim();
  const status = document.getElementById('promo-status-filter').value;
  const tbody = document.getElementById('promo-tbody');
  const empty = document.getElementById('promo-empty');
  const pag = document.getElementById('promo-pagination');
  tbody.innerHTML = '<tr><td colspan="8"><div class="loading-spinner"></div></td></tr>';

  try {
    let url = '/admin/promos?page=' + page;
    if (search) url += '&search=' + encodeURIComponent(search);
    if (status) url += '&status=' + status;
    const data = await apiCall(url);
    promoCurrentPage = data.page;
    tbody.innerHTML = '';

    if (!data.promos || data.promos.length === 0) {
      empty.style.display = '';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    const now = new Date();
    data.promos.forEach(p => {
      const isExpired = p.validUntil && new Date(p.validUntil) < now;
      const isActive = p.active && !isExpired;
      const statusBadge = !p.active
        ? '<span class="badge badge-muted">Désactivé</span>'
        : isExpired
        ? '<span class="badge badge-red">Expiré</span>'
        : '<span class="badge badge-green">Actif</span>';

      const reduction = p.discountType === 'PERCENT'
        ? '<strong style="color:var(--green);">-' + p.discountValue + '%</strong>'
        : '<strong style="color:var(--green);">-' + p.discountValue.toLocaleString('fr-FR') + ' FCFA</strong>';

      const tiers = p.applicableTiers && p.applicableTiers.length > 0
        ? p.applicableTiers.map(t => '<span class="badge badge-blue" style="font-size:10px;">' + t + '</span>').join(' ')
        : '<span style="font-size:11px;color:var(--muted);">Tous</span>';

      const maxUses = p.maxUses ? p.usedCount + ' / ' + p.maxUses : p.usedCount + ' / ∞';
      const usagePct = p.maxUses ? Math.round((p.usedCount / p.maxUses) * 100) : null;
      const usageBar = usagePct !== null
        ? `<div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;margin-top:4px;"><div style="height:100%;width:${usagePct}%;background:var(--orange);border-radius:2px;"></div></div>`
        : '';

      const validStr = p.validUntil
        ? 'jusqu\'au ' + new Date(p.validUntil).toLocaleDateString('fr-FR')
        : 'Permanent';

      tbody.innerHTML += `<tr>
        <td><code style="font-size:13px;font-weight:700;color:var(--orange);letter-spacing:1px;">${escHtml(p.code)}</code></td>
        <td style="color:var(--muted);font-size:12px;">${escHtml(p.description || '—')}</td>
        <td>${reduction}</td>
        <td>${tiers}</td>
        <td>
          <span style="font-size:13px;">${maxUses}</span>
          ${usageBar}
        </td>
        <td style="font-size:12px;color:var(--muted);">${validStr}</td>
        <td>${statusBadge}</td>
        <td class="td-actions">
          <button class="btn btn-view" onclick="openPromoUsages('${p.id}','${escHtml(p.code)}')">📊</button>
          <button class="btn btn-view" onclick="openPromoModal('${p.id}')">✏️</button>
          <button class="btn ${isActive ? 'btn-reject' : 'btn-approve'}" onclick="togglePromo('${p.id}',${p.active})">${p.active ? '⏸' : '▶'}</button>
          <button class="btn btn-reject" onclick="deletePromo('${p.id}','${escHtml(p.code)}')">🗑️</button>
        </td>
      </tr>`;
    });

    pag.style.display = data.pages > 1 ? 'flex' : 'none';
    document.getElementById('promo-page-info').textContent = 'Page ' + data.page + ' / ' + data.pages + ' — ' + data.total + ' code(s)';
    document.getElementById('promo-prev').disabled = data.page <= 1;
    document.getElementById('promo-next').disabled = data.page >= data.pages;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--red);">Erreur de chargement</td></tr>';
  }
}

function debouncePromos() {
  clearTimeout(promoSearchTimer);
  promoSearchTimer = setTimeout(() => loadPromos(1), 350);
}

function updatePromoValueLabel() {
  const type = document.getElementById('promo-type').value;
  document.getElementById('promo-value-label').textContent = 'VALEUR * ' + (type === 'PERCENT' ? '(%)' : '(FCFA)');
}

function openPromoModal(editId) {
  _editingPromoId = editId || null;
  const isEdit = !!editId;
  document.getElementById('promo-modal-title').textContent = isEdit ? '✏️ Modifier le code promo' : '🎁 Nouveau code promo';
  document.getElementById('promo-modal-subtitle').textContent = isEdit ? 'Modifier les paramètres de ce code.' : 'Créer un code de réduction pour les abonnements.';
  document.getElementById('promo-modal-save-btn').textContent = isEdit ? 'Enregistrer' : 'Créer le code';
  document.getElementById('promo-modal-error').style.display = 'none';

  if (!isEdit) {
    // Reset form
    document.getElementById('promo-code').value = '';
    document.getElementById('promo-code').disabled = false;
    document.getElementById('promo-type').value = 'PERCENT';
    document.getElementById('promo-value').value = '';
    document.getElementById('promo-max-uses').value = '';
    document.getElementById('promo-desc').value = '';
    document.getElementById('promo-valid-from').value = '';
    document.getElementById('promo-valid-until').value = '';
    document.getElementById('promo-tier-essentiel').checked = false;
    document.getElementById('promo-tier-pro').checked = false;
    document.getElementById('promo-tier-elite').checked = false;
    document.getElementById('promo-active').checked = true;
    updatePromoValueLabel();
  } else {
    // Charger les données existantes
    loadPromoForEdit(editId);
  }

  document.getElementById('modal-promo').classList.add('show');
}

async function loadPromoForEdit(promoId) {
  try {
    const data = await apiCall('/admin/promos?search=&page=1');
    const promo = data.promos.find(p => p.id === promoId);
    if (!promo) return;

    document.getElementById('promo-code').value = promo.code;
    document.getElementById('promo-code').disabled = true; // code non modifiable
    document.getElementById('promo-type').value = promo.discountType;
    document.getElementById('promo-value').value = promo.discountValue;
    document.getElementById('promo-max-uses').value = promo.maxUses || '';
    document.getElementById('promo-desc').value = promo.description || '';
    document.getElementById('promo-valid-from').value = promo.validFrom ? promo.validFrom.slice(0, 16) : '';
    document.getElementById('promo-valid-until').value = promo.validUntil ? promo.validUntil.slice(0, 16) : '';
    document.getElementById('promo-tier-essentiel').checked = promo.applicableTiers?.includes('ESSENTIEL');
    document.getElementById('promo-tier-pro').checked = promo.applicableTiers?.includes('PRO');
    document.getElementById('promo-tier-elite').checked = promo.applicableTiers?.includes('ELITE');
    document.getElementById('promo-active').checked = promo.active;
    updatePromoValueLabel();
  } catch(e) {}
}

async function savePromo() {
  const errEl = document.getElementById('promo-modal-error');
  errEl.style.display = 'none';
  const isEdit = !!_editingPromoId;

  const code = document.getElementById('promo-code').value.trim().toUpperCase();
  const discountType = document.getElementById('promo-type').value;
  const discountValue = parseFloat(document.getElementById('promo-value').value);
  const maxUses = document.getElementById('promo-max-uses').value || null;
  const description = document.getElementById('promo-desc').value.trim();
  const validFrom = document.getElementById('promo-valid-from').value || null;
  const validUntil = document.getElementById('promo-valid-until').value || null;
  const active = document.getElementById('promo-active').checked;
  const applicableTiers = ['ESSENTIEL', 'PRO', 'ELITE'].filter(t =>
    document.getElementById('promo-tier-' + t.toLowerCase()).checked
  );

  if (!isEdit && !code) { errEl.textContent = 'Le code est requis'; errEl.style.display = 'block'; return; }
  if (isNaN(discountValue) || discountValue <= 0) { errEl.textContent = 'Valeur de réduction invalide'; errEl.style.display = 'block'; return; }
  if (discountType === 'PERCENT' && discountValue > 100) { errEl.textContent = 'Le pourcentage ne peut pas dépasser 100%'; errEl.style.display = 'block'; return; }

  const body = { discountType, discountValue, maxUses, description, validFrom, validUntil, applicableTiers, active };
  if (!isEdit) body.code = code;

  try {
    const btn = document.getElementById('promo-modal-save-btn');
    btn.disabled = true;
    btn.textContent = 'Enregistrement…';

    if (isEdit) {
      await apiCall('/admin/promos/' + _editingPromoId, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiCall('/admin/promos', { method: 'POST', body: JSON.stringify(body) });
    }

    closeModal('modal-promo');
    showToast(isEdit ? 'Code promo mis à jour' : 'Code promo créé');
    loadPromos(promoCurrentPage);
    loadPromoStats();
  } catch(e) {
    errEl.textContent = e.message || 'Erreur lors de l\'enregistrement';
    errEl.style.display = 'block';
  } finally {
    const btn = document.getElementById('promo-modal-save-btn');
    btn.disabled = false;
    btn.textContent = _editingPromoId ? 'Enregistrer' : 'Créer le code';
  }
}

async function togglePromo(promoId, currentActive) {
  try {
    await apiCall('/admin/promos/' + promoId, { method: 'PATCH', body: JSON.stringify({ active: !currentActive }) });
    showToast(currentActive ? 'Code promo désactivé' : 'Code promo activé');
    loadPromos(promoCurrentPage);
    loadPromoStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

async function deletePromo(promoId, code) {
  if (!confirm('Supprimer le code promo "' + code + '" ? Cette action est irréversible.')) return;
  try {
    await apiCall('/admin/promos/' + promoId, { method: 'DELETE' });
    showToast('Code promo supprimé');
    loadPromos(promoCurrentPage);
    loadPromoStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

async function openPromoUsages(promoId, code) {
  document.getElementById('promo-usages-title').textContent = '📊 Utilisations — ' + code;
  document.getElementById('promo-usages-body').innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById('modal-promo-usages').classList.add('show');

  try {
    const usages = await apiCall('/admin/promos/' + promoId + '/usages');
    if (usages.length === 0) {
      document.getElementById('promo-usages-body').innerHTML = '<div class="empty-state"><div class="es-icon">📊</div><p>Aucune utilisation pour ce code</p></div>';
      return;
    }

    let html = '<div class="table-wrap"><table><thead><tr><th>Professionnel</th><th>Plan</th><th>Prix original</th><th>Réduction</th><th>Prix final</th><th>Date</th></tr></thead><tbody>';
    usages.forEach(u => {
      const pName = u.professional ? u.professional.user.firstName + ' ' + u.professional.user.lastName : '—';
      html += `<tr>
        <td>
          <strong>${escHtml(pName)}</strong><br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(u.professional?.user?.email || '')}</span>
        </td>
        <td><span class="badge badge-blue">${escHtml(u.tier)}</span></td>
        <td style="color:var(--muted);">${u.originalAmount.toLocaleString('fr-FR')} FCFA</td>
        <td style="color:var(--green);">-${u.discountAmount.toLocaleString('fr-FR')} FCFA</td>
        <td style="font-weight:700;color:var(--white);">${u.finalAmount.toLocaleString('fr-FR')} FCFA</td>
        <td style="font-size:11px;color:var(--muted);">${new Date(u.usedAt).toLocaleDateString('fr-FR')}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    document.getElementById('promo-usages-body').innerHTML = html;
  } catch(e) {
    document.getElementById('promo-usages-body').innerHTML = '<div style="color:var(--red);text-align:center;padding:20px;">Erreur de chargement</div>';
  }
}

// ══════════════════════════════════════════════════════════════
// PORTFOLIOS & RÉALISATIONS
// ══════════════════════════════════════════════════════════════
let pfCurrentPage = 1;
let pfSearchTimer = null;
let _currentPfProjectId = null;

async function loadPortfolioStats() {
  try {
    const s = await apiCall('/admin/portfolio/stats');
    document.getElementById('pf-projects').textContent = s.totalProjects ?? '--';
    document.getElementById('pf-likes').textContent = s.totalLikes ?? '--';
    document.getElementById('pf-comments').textContent = s.totalComments ?? '--';
    document.getElementById('pf-items').textContent = s.totalItems ?? '--';

    const topAlert = document.getElementById('pf-top-alert');
    if (s.topProject) {
      const pName = s.topProject.professional?.user
        ? s.topProject.professional.user.firstName + ' ' + s.topProject.professional.user.lastName
        : 'Inconnu';
      topAlert.innerHTML = '🏆 Réalisation la plus aimée : <strong>' + escHtml(s.topProject.title) + '</strong> par ' + escHtml(pName) + ' — ' + s.topProject._count.likes + ' j\'aime · ' + s.topProject._count.comments + ' commentaires';
      topAlert.style.display = '';
    }
  } catch(e) {}
}

async function loadPortfolioProjects(page) {
  page = Math.max(1, page || 1);
  const search = document.getElementById('pf-search').value.trim();
  const cat = document.getElementById('pf-cat-filter').value;
  const tbody = document.getElementById('pf-tbody');
  const empty = document.getElementById('pf-empty');
  const pag = document.getElementById('pf-pagination');
  tbody.innerHTML = '<tr><td colspan="10"><div class="loading-spinner"></div></td></tr>';

  try {
    let url = '/admin/portfolio/projects?page=' + page;
    if (search) url += '&search=' + encodeURIComponent(search);
    if (cat) url += '&category=' + encodeURIComponent(cat);
    const data = await apiCall(url);
    pfCurrentPage = data.page;
    tbody.innerHTML = '';

    if (!data.projects || data.projects.length === 0) {
      empty.style.display = '';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    data.projects.forEach(p => {
      const proName = p.professional ? p.professional.user.firstName + ' ' + p.professional.user.lastName : '—';
      const thumb = p.images && p.images.length > 0
        ? `<img src="${escHtml(p.images[0].imageUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--border);">`
        : '<div style="width:48px;height:48px;background:var(--dark4);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px;">🖼️</div>';

      tbody.innerHTML += `<tr>
        <td>${thumb}</td>
        <td><strong>${escHtml(p.title)}</strong></td>
        <td><span class="badge badge-blue">${escHtml(p.tradeCategory || '—')}</span></td>
        <td>
          <strong>${escHtml(proName)}</strong><br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(p.professional?.user?.email || '')}</span>
        </td>
        <td>${escHtml(p.professional?.user?.city || '—')}</td>
        <td style="color:var(--red);">❤️ ${p._count.likes}</td>
        <td style="color:var(--blue);">💬 ${p._count.comments}</td>
        <td>📸 ${p._count.images}</td>
        <td style="font-size:11px;color:var(--muted);">${new Date(p.createdAt).toLocaleDateString('fr-FR')}</td>
        <td class="td-actions">
          <button class="btn btn-view" onclick="openPortfolioModal('${p.id}')">🔍 Voir</button>
          <button class="btn btn-reject" onclick="confirmDeletePortfolio('${p.id}', ${JSON.stringify(p.title)})">🗑️</button>
        </td>
      </tr>`;
    });

    pag.style.display = data.pages > 1 ? 'flex' : 'none';
    document.getElementById('pf-page-info').textContent = 'Page ' + data.page + ' / ' + data.pages + ' — ' + data.total + ' réalisation(s)';
    document.getElementById('pf-prev').disabled = data.page <= 1;
    document.getElementById('pf-next').disabled = data.page >= data.pages;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--red);">Erreur de chargement</td></tr>';
  }
}

function debouncePf() {
  clearTimeout(pfSearchTimer);
  pfSearchTimer = setTimeout(() => loadPortfolioProjects(1), 350);
}

async function openPortfolioModal(projectId) {
  _currentPfProjectId = projectId;
  const overlay = document.getElementById('modal-portfolio-project');
  overlay.classList.add('show');
  document.getElementById('pf-modal-title').textContent = 'Chargement…';
  document.getElementById('pf-modal-meta').textContent = '';
  document.getElementById('pf-modal-gallery').innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById('pf-modal-desc').textContent = '';
  document.getElementById('pf-modal-stats').innerHTML = '';
  document.getElementById('pf-modal-comments-list').innerHTML = '';
  document.getElementById('pf-modal-no-comments').style.display = 'none';

  try {
    const p = await apiCall('/admin/portfolio/projects/' + projectId);
    const proName = p.professional
      ? (p.professional.companyName || p.professional.user.firstName + ' ' + p.professional.user.lastName)
      : '—';

    document.getElementById('pf-modal-title').textContent = '🖼️ ' + p.title;
    document.getElementById('pf-modal-meta').textContent =
      escHtml(p.tradeCategory || '') + ' • par ' + proName +
      ' (' + (p.professional?.user?.city || '—') + ')' +
      ' • ' + new Date(p.createdAt).toLocaleDateString('fr-FR');
    document.getElementById('pf-modal-delete-btn').setAttribute('data-id', p.id);

    // Galerie
    const gallery = document.getElementById('pf-modal-gallery');
    if (p.images && p.images.length > 0) {
      gallery.innerHTML = p.images.map(img =>
        `<img src="${escHtml(img.imageUrl)}" style="height:160px;min-width:200px;object-fit:cover;border-radius:12px;border:1px solid var(--border);cursor:pointer;" onclick="viewDocImage('${escHtml(img.imageUrl)}','Photo')"`+ `>`
      ).join('');
    } else {
      gallery.innerHTML = '<div style="color:var(--muted);font-size:13px;">Aucune photo</div>';
    }

    // Description
    document.getElementById('pf-modal-desc').textContent = p.description || 'Aucune description';

    // Stats
    document.getElementById('pf-modal-stats').innerHTML = `
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;text-align:center;">
        <div style="font-size:24px;margin-bottom:4px;">❤️</div>
        <div style="font-size:22px;font-weight:800;color:var(--white);">${p.likes.length}</div>
        <div style="font-size:11px;color:var(--muted);">J'aime</div>
      </div>
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;text-align:center;">
        <div style="font-size:24px;margin-bottom:4px;">💬</div>
        <div style="font-size:22px;font-weight:800;color:var(--white);">${p.comments.length}</div>
        <div style="font-size:11px;color:var(--muted);">Commentaires</div>
      </div>
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;text-align:center;">
        <div style="font-size:24px;margin-bottom:4px;">📸</div>
        <div style="font-size:22px;font-weight:800;color:var(--white);">${p.images.length}</div>
        <div style="font-size:11px;color:var(--muted);">Photos</div>
      </div>
    `;

    // Commentaires
    const commentCount = p.comments.reduce((acc, c) => acc + 1 + (c.replies?.length || 0), 0);
    document.getElementById('pf-modal-comment-count').textContent = commentCount;

    if (p.comments.length === 0) {
      document.getElementById('pf-modal-no-comments').style.display = '';
    } else {
      const list = document.getElementById('pf-modal-comments-list');
      list.innerHTML = '';
      p.comments.forEach(c => {
        const author = c.author ? c.author.firstName + ' ' + c.author.lastName : 'Inconnu';
        const ratingStars = c.rating ? '⭐'.repeat(c.rating) : '';
        let html = `<div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div>
              <strong style="font-size:13px;color:var(--white);">${escHtml(author)}</strong>
              ${ratingStars ? `<span style="margin-left:8px;font-size:12px;">${ratingStars}</span>` : ''}
              <span style="font-size:11px;color:var(--muted);margin-left:8px;">${new Date(c.createdAt).toLocaleDateString('fr-FR')}</span>
            </div>
            <button class="btn btn-reject" style="padding:4px 10px;font-size:11px;" onclick="deletePortfolioComment('${c.id}','${p.id}')">🗑️</button>
          </div>
          <p style="font-size:13px;color:var(--light);margin:0;">${escHtml(c.content)}</p>`;

        if (c.replies && c.replies.length > 0) {
          c.replies.forEach(r => {
            const rAuthor = r.author ? r.author.firstName + ' ' + r.author.lastName : 'Inconnu';
            html += `<div style="margin-top:8px;padding-left:14px;border-left:2px solid var(--border);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <strong style="font-size:12px;color:var(--muted);">↩ ${escHtml(rAuthor)}</strong>
                <button class="btn btn-reject" style="padding:3px 8px;font-size:10px;" onclick="deletePortfolioComment('${r.id}','${p.id}')">🗑️</button>
              </div>
              <p style="font-size:12px;color:var(--light);margin:0;">${escHtml(r.content)}</p>
            </div>`;
          });
        }
        html += '</div>';
        list.innerHTML += html;
      });
    }
  } catch(e) {
    document.getElementById('pf-modal-title').textContent = 'Erreur de chargement';
  }
}

async function deletePortfolioProject() {
  const id = _currentPfProjectId;
  if (!id) return;
  if (!confirm('Supprimer cette réalisation et toutes ses photos / commentaires ?')) return;
  try {
    await apiCall('/admin/portfolio/projects/' + id, { method: 'DELETE' });
    closeModal('modal-portfolio-project');
    showToast('Réalisation supprimée');
    loadPortfolioProjects(pfCurrentPage);
    loadPortfolioStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

async function confirmDeletePortfolio(id, title) {
  if (!confirm('Supprimer la réalisation "' + title + '" ?')) return;
  try {
    await apiCall('/admin/portfolio/projects/' + id, { method: 'DELETE' });
    showToast('Réalisation supprimée');
    loadPortfolioProjects(pfCurrentPage);
    loadPortfolioStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

async function deletePortfolioComment(commentId, projectId) {
  if (!confirm('Supprimer ce commentaire ?')) return;
  try {
    await apiCall('/admin/portfolio/comments/' + commentId, { method: 'DELETE' });
    showToast('Commentaire supprimé');
    openPortfolioModal(projectId); // recharger le modal
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

// ══════════════════════════════════════════════════════════════
// GESTION DES ENTREPRISES
// ══════════════════════════════════════════════════════════════
let cmpCurrentPage = 1;
let cmpSearchTimer = null;

async function loadCompanyStats() {
  try {
    const s = await apiCall('/admin/companies/stats');
    document.getElementById('cmp-total').textContent = s.totalCompanies ?? '--';
    document.getElementById('cmp-members').textContent = s.totalMembers ?? '--';
    document.getElementById('cmp-coverage').textContent = (s.coverageRate != null) ? s.coverageRate + '%' : '--';
    document.getElementById('cmp-independents').textContent = s.totalIndependents ?? '--';
  } catch(e) {}
}

async function loadCompanies(page) {
  page = Math.max(1, page || 1);
  const search = document.getElementById('cmp-search').value.trim();
  const tbody = document.getElementById('cmp-tbody');
  const empty = document.getElementById('cmp-empty');
  const pag = document.getElementById('cmp-pagination');
  tbody.innerHTML = '<tr><td colspan="9"><div class="loading-spinner"></div></td></tr>';

  try {
    let url = '/admin/companies?page=' + page;
    if (search) url += '&search=' + encodeURIComponent(search);
    const data = await apiCall(url);
    cmpCurrentPage = data.page;
    tbody.innerHTML = '';

    if (!data.companies || data.companies.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = '';
      pag.style.display = 'none';
      return;
    }
    empty.style.display = 'none';

    data.companies.forEach(c => {
      const name = c.companyName || (c.user.firstName + ' ' + c.user.lastName);
      const quality = c.qualityRate != null ? c.qualityRate + '%' : '—';
      const qualityColor = c.qualityRate >= 80 ? 'var(--green)' : c.qualityRate >= 50 ? 'var(--yellow)' : 'var(--red)';
      const plan = c.subscription?.status === 'ACTIVE' ? '<span class="badge badge-yellow">⭐ ' + (c.subscription.tier || 'Premium') + '</span>' : '<span class="badge badge-muted">Gratuit</span>';
      const rating = c.averageRating > 0 ? '⭐ ' + c.averageRating.toFixed(1) : '—';
      const suspended = c.user.suspended ? '<span class="badge badge-red">Suspendu</span> ' : '';

      tbody.innerHTML += `<tr>
        <td>
          ${suspended}
          <strong>${escHtml(name)}</strong><br>
          <span style="font-size:11px;color:var(--muted);">${escHtml(c.user.email)}</span>
        </td>
        <td><code style="font-size:11px;color:var(--orange);">${escHtml(c.companyCode || '—')}</code></td>
        <td>${escHtml(c.trade || '—')}</td>
        <td>${escHtml(c.user.city || '—')}</td>
        <td style="font-weight:700;color:var(--white);">${c.memberCount}</td>
        <td style="font-weight:700;color:${qualityColor};">${quality}</td>
        <td>${rating}</td>
        <td>${plan}</td>
        <td class="td-actions">
          <button class="btn btn-view" onclick="openCompanyModal('${c.id}')">🔍 Détail</button>
        </td>
      </tr>`;
    });

    pag.style.display = data.pages > 1 ? 'flex' : 'none';
    document.getElementById('cmp-page-info').textContent = 'Page ' + data.page + ' / ' + data.pages + ' — ' + data.total + ' entreprise(s)';
    document.getElementById('cmp-prev').disabled = data.page <= 1;
    document.getElementById('cmp-next').disabled = data.page >= data.pages;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--red);">Erreur de chargement</td></tr>';
  }
}

function debounceCompanies() {
  clearTimeout(cmpSearchTimer);
  cmpSearchTimer = setTimeout(() => loadCompanies(1), 350);
}

let _currentCompanyId = null;

async function openCompanyModal(companyId) {
  _currentCompanyId = companyId;
  const overlay = document.getElementById('modal-company');
  overlay.classList.add('show');
  document.getElementById('cmp-modal-name').textContent = 'Chargement…';
  document.getElementById('cmp-modal-meta').textContent = '';
  document.getElementById('cmp-modal-kpis').innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById('cmp-modal-members').innerHTML = '';
  document.getElementById('cmp-modal-empty').style.display = 'none';

  try {
    const c = await apiCall('/admin/companies/' + companyId);
    const name = c.companyName || (c.user.firstName + ' ' + c.user.lastName);
    document.getElementById('cmp-modal-name').textContent = '🏢 ' + name;
    document.getElementById('cmp-modal-meta').textContent =
      (c.companyCode || '') + ' • ' + (c.user.email || '') + ' • ' + (c.user.city || '—') + ' • Inscrit le ' + new Date(c.createdAt).toLocaleDateString('fr-FR');

    const subLabel = c.subscription?.status === 'ACTIVE'
      ? '⭐ ' + (c.subscription.tier || 'Premium') + ' (exp. ' + new Date(c.subscription.expiresAt).toLocaleDateString('fr-FR') + ')'
      : 'Gratuit';

    document.getElementById('cmp-modal-kpis').innerHTML = `
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">MÉTIER</div>
        <div style="font-size:15px;font-weight:700;color:var(--white);">${escHtml(c.trade || '—')}</div>
      </div>
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">NOTE MOYENNE</div>
        <div style="font-size:15px;font-weight:700;color:var(--white);">${c.averageRating > 0 ? '⭐ ' + c.averageRating.toFixed(1) + ' (' + c.reviewCount + ' avis)' : '—'}</div>
      </div>
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">MISSIONS</div>
        <div style="font-size:15px;font-weight:700;color:var(--white);">${c.completedMissionsCount} terminées · ${c.cancelledMissionsCount} annulées</div>
      </div>
      <div style="background:var(--dark3);border:1px solid var(--border);border-radius:14px;padding:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">ABONNEMENT</div>
        <div style="font-size:15px;font-weight:700;color:var(--gold);">${subLabel}</div>
      </div>
    `;

    const members = c.companyMembers || [];
    document.getElementById('cmp-modal-member-count').textContent = members.length;

    if (members.length === 0) {
      document.getElementById('cmp-modal-empty').style.display = '';
    } else {
      const tbody = document.getElementById('cmp-modal-members');
      tbody.innerHTML = '';
      members.forEach(m => {
        const p = m.member;
        const mName = p.user.firstName + ' ' + p.user.lastName;
        const idBadge = p.identityStatus === 'APPROVED'
          ? '<span class="badge badge-green">✓ Vérifié</span>'
          : p.identityStatus === 'PENDING'
          ? '<span class="badge badge-yellow">⏳ En attente</span>'
          : '<span class="badge badge-muted">Non soumis</span>';
        const rating = p.averageRating > 0 ? '⭐ ' + p.averageRating.toFixed(1) : '—';
        tbody.innerHTML += `<tr>
          <td>
            <strong>${escHtml(mName)}</strong><br>
            <span style="font-size:11px;color:var(--muted);">${escHtml(p.user.email || '')}</span>
          </td>
          <td>${escHtml(p.trade || '—')}</td>
          <td>${escHtml(p.user.city || '—')}</td>
          <td>${rating}</td>
          <td>${p.completedMissionsCount}</td>
          <td>${idBadge}</td>
          <td style="font-size:11px;color:var(--muted);">${new Date(m.joinedAt).toLocaleDateString('fr-FR')}</td>
          <td class="td-actions">
            <button class="btn btn-reject" onclick="removeMember('${c.id}','${p.id}','${escHtml(mName)}')">Retirer</button>
          </td>
        </tr>`;
      });
    }
  } catch(e) {
    document.getElementById('cmp-modal-name').textContent = 'Erreur de chargement';
  }
}

async function removeMember(companyId, memberId, memberName) {
  if (!confirm('Retirer ' + memberName + ' de cette entreprise ?')) return;
  try {
    await apiCall('/admin/companies/' + companyId + '/members/' + memberId, { method: 'DELETE' });
    showToast('Membre retiré de l\'entreprise');
    openCompanyModal(companyId); // recharger le détail
    loadCompanies(cmpCurrentPage);
    loadCompanyStats();
  } catch(e) {
    showToast('Erreur : ' + e.message, true);
  }
}

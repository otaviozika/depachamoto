(() => {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  function message(id, text, type = '') {
    const el = byId(id);
    if (!el) return;
    el.innerHTML = text ? `<div class="msg ${type}">${text}</div>` : '';
  }

  window.openPasswordRecoveryModal = function () {
    const modal = byId('passwordRecoveryModal');
    if (!modal) return;
    const username = byId('loginUser')?.value?.trim() || '';
    byId('passwordRecoveryUsername').value = username;
    byId('passwordRecoveryResetUsername').value = username;
    window.showPasswordRecoveryRequestStep();
    message('passwordRecoveryMsg', '');
    modal.style.display = 'grid';
    setTimeout(() => byId('passwordRecoveryUsername')?.focus(), 30);
  };

  window.closePasswordRecoveryModal = function () {
    const modal = byId('passwordRecoveryModal');
    if (modal) modal.style.display = 'none';
    if (typeof window.hideAllPasswords === 'function') window.hideAllPasswords();
  };

  window.showPasswordRecoveryRequestStep = function () {
    byId('passwordRecoveryRequestStep')?.classList.remove('hidden');
    byId('passwordRecoveryResetStep')?.classList.add('hidden');
    message('passwordRecoveryMsg', '');
  };

  window.showPasswordRecoveryResetStep = function () {
    const username = byId('passwordRecoveryUsername')?.value?.trim() || byId('loginUser')?.value?.trim() || '';
    if (byId('passwordRecoveryResetUsername')) byId('passwordRecoveryResetUsername').value = username;
    byId('passwordRecoveryRequestStep')?.classList.add('hidden');
    byId('passwordRecoveryResetStep')?.classList.remove('hidden');
    message('passwordRecoveryMsg', '');
    setTimeout(() => byId('passwordRecoveryCode')?.focus(), 30);
  };

  window.submitPasswordRecoveryRequest = async function (event) {
    event.preventDefault();
    const username = byId('passwordRecoveryUsername').value.trim();
    message('passwordRecoveryMsg', 'Enviando solicitação...');
    try {
      const response = await fetch('/api/password-recovery/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível solicitar a recuperação.');
      byId('passwordRecoveryResetUsername').value = username;
      message('passwordRecoveryMsg', esc(data.message || 'Solicitação enviada ao administrador.'), 'ok');
      setTimeout(() => window.showPasswordRecoveryResetStep(), 900);
    } catch (error) {
      message('passwordRecoveryMsg', esc(error.message), 'err');
    }
  };

  window.submitPasswordRecoveryReset = async function (event) {
    event.preventDefault();
    const username = byId('passwordRecoveryResetUsername').value.trim();
    const code = byId('passwordRecoveryCode').value.trim();
    const new_password = byId('recoveryPass').value;
    const confirm_password = byId('recoveryPass2').value;
    if (new_password !== confirm_password) return message('passwordRecoveryMsg', 'As senhas não coincidem.', 'err');
    message('passwordRecoveryMsg', 'Validando código...');
    try {
      const response = await fetch('/api/password-recovery/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, code, new_password, confirm_password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível alterar a senha.');
      message('passwordRecoveryMsg', esc(data.message || 'Senha alterada com sucesso.'), 'ok');
      if (byId('loginUser')) byId('loginUser').value = username;
      if (byId('loginPass')) byId('loginPass').value = '';
      byId('passwordRecoveryResetForm')?.reset();
      setTimeout(() => window.closePasswordRecoveryModal(), 1400);
    } catch (error) {
      message('passwordRecoveryMsg', esc(error.message), 'err');
    }
  };

  window.closePasswordRecoveryAdminModal = function () {
    const modal = byId('passwordRecoveryAdminModal');
    if (modal) modal.style.display = 'none';
  };

  const statusLabel = status => ({
    PENDING: 'Pendente', APPROVED: 'Código gerado', USED: 'Concluída', EXPIRED: 'Expirada', REJECTED: 'Recusada'
  })[status] || status;

  const dateTime = value => {
    if (!value) return '—';
    try { return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
    catch { return value; }
  };

  window.openPasswordRecoveryAdminModal = async function () {
    const modal = byId('passwordRecoveryAdminModal');
    if (!modal) return;
    modal.style.display = 'grid';
    message('passwordRecoveryAdminMsg', '');
    await window.loadPasswordRecoveryAdmin();
  };

  window.loadPasswordRecoveryAdmin = async function () {
    const list = byId('passwordRecoveryAdminList');
    if (!list) return;
    list.innerHTML = '<div class="empty">Carregando...</div>';
    try {
      const response = await fetch('/api/admin/password-recovery');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Falha ao carregar solicitações.');
      const rows = data.rows || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty">Nenhuma solicitação nos últimos 7 dias.</div>';
        return;
      }
      list.innerHTML = rows.map(row => `<div class="password-recovery-item status-${esc(row.status.toLowerCase())}">
        <div class="password-recovery-item-main"><b>${esc(row.name)}</b><span>@${esc(row.username)}</span><small>Solicitado em ${dateTime(row.requested_at)}</small></div>
        <div class="password-recovery-status">${esc(statusLabel(row.status))}</div>
        <div class="password-recovery-actions">${row.status === 'PENDING'
          ? `<button class="btn primary" type="button" onclick="approvePasswordRecovery(${Number(row.id)})">Gerar código</button><button class="btn outline" type="button" onclick="rejectPasswordRecovery(${Number(row.id)})">Recusar</button>`
          : row.status === 'APPROVED'
            ? `<span class="small muted">Expira em ${dateTime(row.expires_at)}</span><button class="btn outline" type="button" onclick="rejectPasswordRecovery(${Number(row.id)})">Cancelar</button>`
            : ''}</div>
      </div>`).join('');
    } catch (error) {
      list.innerHTML = `<div class="msg err">${esc(error.message)}</div>`;
    }
  };

  window.approvePasswordRecovery = async function (id) {
    message('passwordRecoveryAdminMsg', 'Gerando código...');
    try {
      const response = await fetch(`/api/admin/password-recovery/${id}/approve`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível aprovar.');
      message('passwordRecoveryAdminMsg', `Código de <b>${esc(data.name)}</b>: <span class="password-recovery-code">${esc(data.code)}</span><br><span class="small">Válido por 10 minutos. Passe este código diretamente ao motoboy; ele não será exibido novamente.</span>`, 'ok');
      await window.loadPasswordRecoveryAdmin();
    } catch (error) {
      message('passwordRecoveryAdminMsg', esc(error.message), 'err');
    }
  };

  window.rejectPasswordRecovery = async function (id) {
    if (!window.confirm('Recusar/cancelar esta recuperação de senha?')) return;
    try {
      const response = await fetch(`/api/admin/password-recovery/${id}/reject`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível recusar.');
      message('passwordRecoveryAdminMsg', 'Solicitação cancelada.', 'ok');
      await window.loadPasswordRecoveryAdmin();
    } catch (error) {
      message('passwordRecoveryAdminMsg', esc(error.message), 'err');
    }
  };
})();

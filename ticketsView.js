// Shared date formatter: "11. November 2025 06:52"
function formatTicketDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  const day       = String(d.getDate()).padStart(2, '0');
  const monthName = d.toLocaleString('en-GB', { month: 'long' });
  const year      = d.getFullYear();
  const hours     = String(d.getHours()).padStart(2, '0');
  const minutes   = String(d.getMinutes()).padStart(2, '0');
  return `${day}. ${monthName} ${year} ${hours}:${minutes}`;
}

// Shared month-grouping helper
// Returns array of { label, key, items } sorted newest-first (items also sorted newest-first)
function groupByMonth(rows, dateField) {
  const groups = new Map();
  for (const r of rows) {
    const d = new Date(r[dateField]);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const label = d.toLocaleString('no-NO', { month: 'long', year: 'numeric' });
    const key = y * 100 + (m + 1);
    if (!groups.has(key)) groups.set(key, { label, key, items: [] });
    groups.get(key).items.push(r);
  }
  const result = Array.from(groups.values()).sort((a, b) => b.key - a.key);
  result.forEach(g => g.items.sort((a, b) => new Date(b[dateField]) - new Date(a[dateField])));
  return result;
}

window.renderPurchaseHistoryList = function(tix) {
  const root = document.getElementById('ph-list');
  if (!root) return;

  const monthGroups = groupByMonth(tix, 'purchased_at_iso');
  root.innerHTML = '';

  for (const g of monthGroups) {
    const group = document.createElement('div');
    group.className = 'ph-group';

    const h = document.createElement('h3');
    h.className = 'ph-month';
    h.textContent = g.label;
    group.appendChild(h);

    for (const t of g.items) {
      const item = document.createElement('div');
      item.className = 'card ph-item';
      item.innerHTML = `
        <div class="side-bar"></div>
        <div class="ph-content" role="button" tabindex="0" data-ticket-id="${t.id}">
          <div class="ph-title">Expired reis ticket</div>
          <div class="ph-row">
            <div class="ph-meta">
              <div class="ph-meta-item">
                <img class="icon-24 tickets" src="icons/zone.svg" alt="">${(() => { const parts = String(t.zone).split(',').map(s => s.trim()).filter(Boolean); if (parts.length <= 1) return `Zone ${parts[0] || t.zone}`; const last = parts[parts.length - 1]; return `Zones ${parts.slice(0, -1).join(', ')} and ${last}`; })()}
              </div>
            </div>
          </div>
          <div class="ph-row">
            <div class="ph-meta">
              <div class="ph-meta-item">
                <img class="icon-24 tickets" src="icons/happy2.svg" alt="">${t.adults} adult${t.adults > 1 ? 's' : ''}
              </div>
            </div>
          </div>
          <div class="ph-row-tickets ph-row--time">
            <div class="ph-time">
              <img class="icon-24 tickets" src="icons/hourglass.svg" alt="">
              ${formatTicketDate(new Date(t.purchased_at_iso))}
            </div>
            <div class="rcpt-open">
              Show ticket <img class="chev" src="icons/chevron-right-expired.svg" alt="">
            </div>
          </div>
        </div>
      `;
      const content = item.querySelector('.ph-content');
      content.addEventListener('click', () => {
        window.__selectedTicketId = t.id;
        window.__phDefaultTab = 'tickets';
        location.hash = '#ticket_detail';
      });

      group.appendChild(item);
    }
    root.appendChild(group);
  }
};

window.renderReceiptsList = function(rows) {
  const root = document.getElementById('ph-list');
  if (!root) return;

  // Attach delegated click/keyboard handler ONCE
  if (!root.__phDelegated) {
    root.addEventListener('click', (e) => {
      const el = (e.target instanceof Element) ? e.target : (e.target && e.target.parentElement);
      if (!el) return;
      const clickable = el.closest('[data-ticket-id]');
      if (!clickable) return;

      const id = clickable.dataset.ticketId;
      if (typeof window.openTicket === 'function') {
        window.openTicket(id);
      } else {
        document.dispatchEvent(new CustomEvent('ticket:open', { detail: { id } }));
      }
    });
    root.__phDelegated = true;
  }

  const monthGroups = groupByMonth(rows, 'purchased_at_iso');
  root.innerHTML = '';

  for (const g of monthGroups) {
    const wrap = document.createElement('div');
    wrap.className = 'ph-group';

    const h = document.createElement('h3');
    h.className = 'ph-month';
    h.textContent = g.label.charAt(0).toUpperCase() + g.label.slice(1);
    wrap.appendChild(h);

    for (const r of g.items) {
      const dt  = new Date(r.purchased_at_iso);
      const day = String(dt.getUTCDate()).padStart(2, '0');
      const mon = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const yy  = String(dt.getUTCFullYear()).slice(-2);
      const hh  = String(dt.getHours()).padStart(2, '0');
      const mi  = String(dt.getMinutes()).padStart(2, '0');

      const card = document.createElement('article');
      card.className = 'card rcpt-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.dataset.ticketId = r.id;

      card.innerHTML = `
        <div class="rcpt-head">
          <div class="rcpt-title">
            <img class="icon-24" src="icons/ticket3.svg" alt="">
            Ruter ticket
          </div>
          <div class="rcpt-amount">${(r.amount_cents / 100).toFixed(2).replace('.', ',')} kr</div>
        </div>
        <div class="rcpt-sep"></div>
        <div class="rcpt-foot">
          <div class="rcpt-purchase">Purchased ${day}.${mon}.${yy} at ${hh}:${mi}</div>
          <div class="rcpt-open">
            <img class="chev" src="icons/chevron-right.svg" alt="">
          </div>
        </div>
      `;

      wrap.appendChild(card);
    }

    root.appendChild(wrap);
  }
};

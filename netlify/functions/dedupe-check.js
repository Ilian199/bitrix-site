// netlify/functions/dedupe-check.js
//
// Принимает вызов от робота "Исходящий вебхук" в Bitrix24 (стадия "Новая"),
// проверяет, есть ли у клиента другая открытая сделка по тому же телефону,
// и если да — помечает текущую сделку как повторное обращение.
//
// ВАЖНО: URL входящего вебхука портала (с секретным кодом доступа) НЕ
// хранится в этом файле. Он читается из переменной окружения
// BITRIX_WEBHOOK_URL, которую нужно задать в настройках Netlify
// (Site settings → Environment variables), а не в коде.

exports.handler = async (event) => {
  try {
    const webhookBase = process.env.BITRIX_WEBHOOK_URL;
    if (!webhookBase) {
      return { statusCode: 500, body: 'BITRIX_WEBHOOK_URL is not configured' };
    }

    const params = new URLSearchParams(event.body || '');

    let dealId =
      params.get('document_id[2]') ||
      params.get('deal_id') ||
      params.get('ID') ||
      (event.queryStringParameters && event.queryStringParameters.deal_id);

    if (!dealId) {
      return { statusCode: 400, body: 'deal_id not found in request' };
    }

    dealId = String(dealId).replace(/^DEAL_/i, '');

    const call = async (method, payload) => {
      const res = await fetch(`${webhookBase}${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.json();
    };

    const dealResp = await call('crm.deal.get', { id: dealId });
    const deal = dealResp.result;
    if (!deal) {
      return { statusCode: 404, body: 'Deal not found' };
    }

    const contactId = deal.CONTACT_ID;
    if (!contactId) {
      return { statusCode: 200, body: 'No contact on deal, nothing to check' };
    }

    const contactResp = await call('crm.contact.get', { id: contactId });
    const contact = contactResp.result;
    const phone =
      contact && contact.PHONE && contact.PHONE[0] && contact.PHONE[0].VALUE;

    if (!phone) {
      return { statusCode: 200, body: 'No phone on contact, nothing to check' };
    }

    const dupResp = await call('crm.duplicate.findbycomm', {
      entity_type: 'CONTACT',
      type: 'PHONE',
      values: [phone],
    });

    const foundContactIds = (dupResp.result && dupResp.result.CONTACT) || [];
    if (foundContactIds.length === 0) {
      return { statusCode: 200, body: 'No duplicate contacts found' };
    }

    const dealsResp = await call('crm.deal.list', {
      filter: {
        CONTACT_ID: foundContactIds,
        CLOSED: 'N',
        '!ID': dealId,
      },
      select: ['ID', 'TITLE'],
    });

    const otherOpenDeals = dealsResp.result || [];
    if (otherOpenDeals.length === 0) {
      return { statusCode: 200, body: 'No other open deals, not a repeat contact' };
    }

    const sourceLabel = deal.SOURCE_ID || 'неизвестный источник';

    await call('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: `Повторное обращение из [${sourceLabel}]. У клиента уже есть открытая сделка: #${otherOpenDeals[0].ID} (${otherOpenDeals[0].TITLE})`,
      },
    });

    if (deal.ASSIGNED_BY_ID) {
      await call('im.notify.personal.add', {
        USER_ID: deal.ASSIGNED_BY_ID,
        MESSAGE: `Повторное обращение по сделке #${dealId} — у клиента уже есть открытая сделка #${otherOpenDeals[0].ID}`,
      });
    }

    return { statusCode: 200, body: 'Marked as repeat contact' };
  } catch (err) {
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};

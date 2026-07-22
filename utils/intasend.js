const IS_LIVE_BASE = 'https://api.intasend.com/api/v1';
const IS_TEST_BASE = 'https://sandbox.intasend.com/api/v1';
const IS_BASE =
  process.env.INTASEND_TEST_MODE === 'true'
    ? IS_TEST_BASE
    : IS_LIVE_BASE;

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.INTASEND_SECRET_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function request(url, options) {
  const res = await fetch(url, options);

  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = { message: await res.text() };
  }

  console.log('==============================');
  console.log('IntaSend Request:', options.method, url);
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));
  console.log('==============================');

  if (!res.ok) {
    throw new Error(
      data.detail ||
      data.message ||
      data.error ||
      JSON.stringify(data)
    );
  }

  return data;
}

async function chargeMpesaSTK({ txRef, amount, phoneNumber }) {
  return request(`${IS_BASE}/payment/mpesa-stk-push/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      amount,
      phone_number: phoneNumber,
      api_ref: txRef
    })
  });
}

async function createHostedCheckout({
  txRef,
  amount,
  email,
  name,
  redirectUrl
}) {
  const parts = (name || 'Customer').trim().split(/\s+/);

  return request(`${IS_BASE}/checkout/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      first_name: parts[0],
      last_name: parts.slice(1).join(' ') || parts[0],
      email,
      host: process.env.APP_URL,
      amount,
      currency: 'KES',
      api_ref: txRef,
      redirect_url: redirectUrl,
      channel: 'WEBSITE'
    })
  });
}

async function verifyPayment(invoiceId) {
  const data = await request(`${IS_BASE}/payment/status/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      invoice_id: invoiceId
    })
  });

  return data.invoice || data;
}

async function initiateTransfer({
  txRef,
  amount,
  channel,
  accountNumber,
  bankCode,
  beneficiaryName
}) {
  const provider =
    channel === 'bank'
      ? 'PESALINK'
      : 'MPESA-B2C';

  const transaction = {
    name: beneficiaryName,
    account: accountNumber,
    amount,
    narrative: 'VaultGate withdrawal',
    idempotency_key: txRef
  };

  if (provider === 'PESALINK') {
    transaction.bank_code = bankCode;
  }

  return request(`${IS_BASE}/send-money/initiate/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      currency: 'KES',
      provider,
      requires_approval: 'NO',
      callback_url: `${process.env.APP_URL}/webhooks/intasend`,
      transactions: [transaction]
    })
  });
}

module.exports = {
  chargeMpesaSTK,
  createHostedCheckout,
  verifyPayment,
  initiateTransfer
};

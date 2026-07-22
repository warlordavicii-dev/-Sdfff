const FLW_BASE = 'https://api.flutterwave.com/v3';

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Initiates a mobile money (M-Pesa or Airtel) charge in Kenya.
 * Flutterwave triggers the STK/USSD push to the customer's phone directly.
 */
async function chargeMobileMoneyKE({ txRef, amount, email, phoneNumber, name }) {
  const res = await fetch(`${FLW_BASE}/charges?type=mpesa`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      tx_ref: txRef,
      amount,
      currency: 'KES',
      email,
      phone_number: phoneNumber,
      fullname: name
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to initiate mobile money charge');
  }
  return data;
}

/**
 * Creates a hosted checkout link for bank transfer / card deposits.
 */
async function createHostedCheckout({ txRef, amount, email, name, redirectUrl }) {
  const res = await fetch(`${FLW_BASE}/payments`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      tx_ref: txRef,
      amount,
      currency: 'KES',
      redirect_url: redirectUrl,
      customer: { email, name },
      payment_options: 'banktransfer,card',
      customizations: { title: 'VaultGate Funds' }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to create checkout link');
  }
  return data;
}

/**
 * Always re-verify a transaction server-side using Flutterwave's own record
 * before crediting a wallet. Never trust the webhook payload or a client
 * redirect alone — both can be spoofed or replayed.
 */
async function verifyTransaction(flwTransactionId) {
  const res = await fetch(`${FLW_BASE}/transactions/${flwTransactionId}/verify`, {
    method: 'GET',
    headers: authHeaders()
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to verify transaction');
  }
  return data;
}

/**
 * Initiates a payout (withdrawal) to mobile money or a bank account.
 * bankCode: 'MPS' for M-Pesa, 'AIRTEL' for Airtel Money, or a real bank code for bank transfers.
 */
async function initiateTransfer({ txRef, amount, bankCode, accountNumber, beneficiaryName, senderName }) {
  const isMobileMoney = bankCode === 'MPS' || bankCode === 'AIRTEL';
  const body = {
    account_bank: bankCode,
    account_number: accountNumber,
    amount,
    currency: 'KES',
    reference: txRef,
    beneficiary_name: beneficiaryName,
    narration: 'VaultGate withdrawal'
  };
  if (isMobileMoney) {
    body.meta = {
      sender: senderName,
      sender_country: 'KE',
      mobile_number: accountNumber
    };
  }

  const res = await fetch(`${FLW_BASE}/transfers`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to initiate withdrawal');
  }
  return data;
}

module.exports = {
  chargeMobileMoneyKE,
  createHostedCheckout,
  verifyTransaction,
  initiateTransfer
};

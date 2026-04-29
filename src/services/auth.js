// /**
//  * Authentication configuration for Azure AD SSO.
//  * 
//  * To enable SSO, install @azure/msal-browser and set these env vars:
//  *   VITE_AZURE_CLIENT_ID=your-app-client-id
//  *   VITE_AZURE_TENANT_ID=your-tenant-id
//  * 
//  * Then uncomment the MSAL initialization in services/api.js
//  */

// export const AUTH_CONFIG = {
//   clientId: import.meta.env.VITE_AZURE_CLIENT_ID || '',
//   tenantId: import.meta.env.VITE_AZURE_TENANT_ID || '',
//   redirectUri: typeof window !== 'undefined' ? window.location.origin : '',
//   scopes: [
//     'user.read',
//     'https://management.azure.com/.default',
//   ],
// }

/**
 * Check if SSO is configured (env vars set).
 * When false, the app runs in demo mode with dummy login.
 */
export function isSSOConfigured() {
  return Boolean(AUTH_CONFIG.clientId && AUTH_CONFIG.tenantId)
}

/**
 * Simulated login for demo mode.
 * Returns a mock user object matching the shape of MSAL's account info.
 */
export function getDemoUser() {
  return {
    name: 'Demo User',
    username: 'demo@cloudthat.com',
    localAccountId: 'demo-001',
  }
}

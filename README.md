# ContApp Pe - Backend

Backend principal para ContApp (PayPal + OpenAI), pensado para Cloud Run.

## Requisitos
- Node 20+
- Google Cloud Run (recomendado)
- Firebase Admin SDK

## Variables de entorno
- `CORS_ORIGIN`: dominios permitidos (separados por coma).
- `APP_BASE_URL`: URL del frontend para callbacks (ej: `https://contapp-pe.vercel.app`).
- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account (string en una sola linea).
- `OPENAI_API_KEY`: API key de OpenAI.
- `PAYPAL_ENV`: `live` o `sandbox`.
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`
- `PAYPAL_PLAN_ID_PRO`
- `PAYPAL_PLAN_ID_PLUS`

## Endpoints
- `POST /chat` (requiere auth Firebase)
- `POST /paypal/create-subscription` (requiere auth Firebase)
- `POST /paypal/webhook` (Webhook de PayPal)
- `GET /health`

## Deploy (Cloud Run)
1. Construir imagen: `gcloud builds submit --tag gcr.io/PROJECT_ID/contapp-pe-backend`
2. Desplegar: `gcloud run deploy contapp-pe-backend --image gcr.io/PROJECT_ID/contapp-pe-backend --region us-central1 --allow-unauthenticated`
3. Configurar variables de entorno en Cloud Run

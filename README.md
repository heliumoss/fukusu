![fukusu header](/assets/fukusu-header.png)

## what does it do
fukusu is a middleman between the uploadthing package and your own storage bucket. this means you basically get the freedom to use any provider but with the incredible DX of uploadthing.

> [!WARNING]
> fukusu is still in active development. expect breaking changes.
> currently, fukusu only supports Cloudflare R2.

## supported providers
- [x] Cloudflare R2
- [ ] Backblaze B2
- [ ] Generic S3 provider

## supported features
- [x] uploads
- [ ] multiple apps
- [x] authed requests (currently assumes that everything is authenticated)

## how do i use it
simple! firstly, deploy your fukusu server. you can do this easily with the **Deploy with Cloudflare** button below:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/heliumoss/fukusu)

> [!IMPORTANT]
> Your `UPLOADTHING_TOKEN` must begin with `sk_`. UploadThing will not accept your API Key otherwise.

once your fukusu server is online, you'll need to get your API key. you can get this by going to:
```
https://<your-fukusu-server-url>/__fukusu/genkey?secret=<your_secret_key>
```

> [!NOTE]
> Make sure you replace `<your-fukusu-server-url>` with the URL of your deployed fukusu server.
> Also, make sure you replace `<your_secret_key>` with the `UPLOADTHING_TOKEN` you set when deploying

You can now add environment variables to your `.env` file to configure Uploadthing to work with your fukusu server:

```ini
UPLOADTHING_TOKEN="<your-api-key-here>"
UPLOADTHING_INGEST_URL="https://<your-fukusu-server-url>"
UPLOADTHING_API_URL="http://<your-fukusu-server-url>"
```

For some frameworks (*cough cough svelte cough cough*), you'll need to modify your `createRouteHandler` to include a configuration object that points **UploadThing** to your server.

```ts
// this is an example of how you'd use it in sveltekit:
// /src/routes/api/uploadthing/+server.ts
//
import { env } from '$env/dynamic/private';
import { ourFileRouter } from '$lib/server/uploadthing';

import { createRouteHandler } from 'uploadthing/server';
const handlers = createRouteHandler({
	router: ourFileRouter,
	config: {
		token: env.UPLOADTHING_TOKEN,
		ingestUrl: env.UPLOADTHING_INGEST_URL,
	}
});

export { handlers as GET, handlers as POST };
```

and now your uploads will work! for any `UTApi` instances you also need to add the configuration to them. you may do the following:
```ts
const utApi = new UTApi({
  apiUrl: env.UPLOADTHING_API_URL", // you can also use env.UPLOADTHING_INGEST_URL
  ingestUrl: env.UPLOADTHING_INGEST_URL,
  token: env.UPLOADTHING_TOKEN
});
```

and voila! it's all done.

## why "fukusu"
i googled the translation of "multiple" to japanese.

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

> [!NOTE]
> fukusu is not available at this time. please check back later.

once your fukusu server is online, you'll need to get your API key. You can get this by going to `https://your-fukusu-server.com/__fukusu/genkey?secret=<your_secret_key>`, replacing `<your_secret_key>` with the secret key you set when deploying your fukusu server. you can add this to your `.env` file as `UPLOADTHING_TOKEN`

you can now add your fukusu instance to your `.env` as well with the `UPLOADTHING_INGEST_URL` variable. your `.env` should look something like this:

```
UPLOADTHING_TOKEN=yOuRaPiKeYhErE
UPLOADTHING_INGEST_URL=https://your-fukusu-server.com
```

next, modify your `createRouteHandler` to include a configuration object that points `uploadthing` to your server:

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

and now your uploads will work! for any `UTApi` instances you also need to add the configuration to them in some cases (*cough cough svelte cough cough*). you can do the following:
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

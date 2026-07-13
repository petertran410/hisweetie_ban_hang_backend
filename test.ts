import { HisweetieClient } from '@dieptra/mcp-client';

async function main() {
  const client = new HisweetieClient({
    baseUrl: 'https://sandbox-mcp.hisweetievietnam.com',
    clientId: 'dieptra.sg@gmail.com',
    clientSecret: 'Dieptra@@123',
  });

  const branches = await client.branches.list();
  console.log(branches);
}

main().catch(console.error);

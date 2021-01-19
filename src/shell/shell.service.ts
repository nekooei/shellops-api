import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trim } from 'lodash';
import { NodeSSH } from 'node-ssh';
import { stringify } from 'querystring';

import { ConfigService } from '../config/config.service';
import { WsGateway } from '../ws/ws.gateway';
import { ShellCommandResultDto } from './shell-command-result.dto';
import { ShellConfigDto } from './shell-connect.dto';

export class SshExtended extends NodeSSH {
    #connect: any;

    constructor(public readonly config: ShellConfigDto) {

        super();

        this.#connect = NodeSSH.prototype.connect;
    }

    connect(): Promise<this> {
        return this.#connect(this.config);
    }
}

@Injectable()
export class ShellService implements OnModuleInit {

    constructor(
        private readonly configService: ConfigService,
        private readonly wsGateway: WsGateway) { }


    async onModuleInit() {

        Promise.all(this.configService.config.nodes.map((conn) => this.setupClient(conn)))

    }

    async setupClient(conn: ShellConfigDto) {
        try {

            const client = await this.createAndConnectClient(conn);

            await this.installNodeLTS(client);

            await this.installFreshClientAPI(client);

        } catch (error) {
            Logger.error(error.message, error.stack, ShellService.name);
        }
    }


    async createAndConnectClient({ username, password, host, port, index }: ShellConfigDto) {

        const client = new SshExtended({
            host,
            port,
            username,
            password,
        });

        await client.connect();

        Logger.verbose(`Connected to ssh server: ${host}`)

        return client;

    }

    async dockerIsInstalled(client: SshExtended): Promise<{ isInstalled: boolean, version: string }> {
        const result = await this.runCommand('docker -v', client);

        return { isInstalled: result.outputs[0]?.startsWith('v') || false, version: result.outputs[0] }
    }

    async nodeIsInstalled(client: SshExtended): Promise<{ isInstalled: boolean, version: string }> {
        const result = await this.runCommand('node -v', client);

        return { isInstalled: result.outputs[0]?.startsWith('v') || false, version: result.outputs[0] }
    }

    async npmIsInstalled(client: SshExtended): Promise<{ isInstalled: boolean, version: string }> {
        const result = await this.runCommand('npm -v', client);
        return { isInstalled: result.outputs[0]?.split('.')?.length === 3 || false, version: result.outputs[0] }
    }

    async nIsInstalled(client: SshExtended): Promise<{ isInstalled: boolean, version: string }> {
        const result = await this.runCommand('n -V', client);
        return { isInstalled: result.outputs[0]?.split('.')?.length === 3 || false, version: result.outputs[0] }
    }


    async updateApt(client: SshExtended): Promise<ShellCommandResultDto> {
        const result = await this.runCommand('sudo apt update', client);
        if (result.code)
            throw new Error(JSON.stringify(result, null, 2));

        return result;
    }


    async installFreshClientAPI(client: SshExtended): Promise<void> {

        await this.installNodeLTS(client);

        await this.runCommand('rimraf ~/shellops-api', client);

        await this.runCommand('rimraf ~/.shellops.json', client);

        await this.runCommand('git clone https://github.com/shellops/shellops-api.git ~/shellops-api', client);

        await this.runCommand('cd ~/shellops-api && npm i --no-audit --prefer-offline --no-progress', client);

        await this.runCommand('cd ~/shellops-api && npm run build', client);

        await this.runCommand('cd ~/shellops-api && npm run start:prod', client);

    }


    async installNode(client: SshExtended): Promise<void> {

        if ((await this.nodeIsInstalled(client)).isInstalled) return;

        const result = await this.runCommand('sudo apt install nodejs -y', client);

        if (result.code)
            throw new Error(JSON.stringify(result, null, 2));

    }

    async installNpm(client: SshExtended): Promise<void> {

        if ((await this.npmIsInstalled(client)).isInstalled) return;

        const result = await this.runCommand('sudo apt install npm -y', client);

        if (result.code)
            throw new Error(JSON.stringify(result, null, 2));

    }


    async installDnsProxy(client: SshExtended): Promise<void> {

        const result = await this.runCommand(['sudo apt install resolvconf',
            'sudo systemctl status resolvconf.service',
            'sudo systemctl start resolvconf.service',
            'sudo systemctl enable resolvconf.service',
            'sudo systemctl status resolvconf.service',
            'sudo rm /etc/resolvconf/resolv.conf.d/head',
            'sudo echo "nameserver 178.22.122.100" >> /etc/resolvconf/resolv.conf.d/head',
            'sudo echo "nameserver 185.51.200.2" >> /etc/resolvconf/resolv.conf.d/head',
            'sudo systemctl stop resolvconf.service',
            'sudo systemctl start resolvconf.service',].join(' ; '), client);

        if (result.code)
            throw new Error(JSON.stringify(result, null, 2));


    }
    async installDockerAptKey(client: SshExtended): Promise<void> {
        const aptKeyInstallResult = await this.runCommand('curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -', client);
        if (aptKeyInstallResult.code)
            if (aptKeyInstallResult.errors.find(p => p.includes('403'))) {
                await this.installDnsProxy(client);
                await this.installDockerAptKey(client);
                return;
            } else
                throw new Error(JSON.stringify(aptKeyInstallResult, null, 2));
    }



    async installDocker(client: SshExtended): Promise<void> {

        const depInstallResult = await this.runCommand('sudo apt-get install -y ' +
            ['apt-transport-https',
                'ca-certificates',
                'curl',
                'gnupg-agent',
                'software-properties-common'].join(' '), client);

        if (depInstallResult.code)
            throw new Error(JSON.stringify(depInstallResult, null, 2));

        await this.installDockerAptKey(client);

        const addRepoResult = await this.runCommand(
            [
                'sudo add-apt-repository ',
                '"deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"',
            ].join(' '), client);

        if (addRepoResult.code)
            throw new Error(JSON.stringify(addRepoResult, null, 2));

        await this.updateApt(client);


        const installDockerResult = await this.runCommand('sudo apt-get install -y docker-ce docker-ce-cli containerd.io', client);


        if (installDockerResult.code)
            throw new Error(JSON.stringify(installDockerResult, null, 2));


    }

    async installN(client: SshExtended): Promise<void> {

        await this.installNode(client);

        await this.installNpm(client);

        if ((await this.nIsInstalled(client)).isInstalled) return;

        const installResult = await this.runCommand('sudo npm i -g n', client);

        if (installResult.code)
            throw new Error(JSON.stringify(installResult, null, 2));


        await this.runCommand('PATH="$PATH"', client);



    }

    async latestNodeLtsAvailable(client: SshExtended): Promise<ShellCommandResultDto> {


        const result = await this.runCommand('n --lts', client);


        if (result.code)
            throw new Error(JSON.stringify(result, null, 2));

        return result;

    }

    async installNodeLTS(client: SshExtended): Promise<void> {

        await this.installN(client);

        const { outputs: [latestNodeVersion] } = await this.latestNodeLtsAvailable(client);
        const { version: currentNodeVersion } = await this.nodeIsInstalled(client);


        if (latestNodeVersion === currentNodeVersion) return;

        const result = await this.runCommand('n lts', client);

        if (result.code)
            throw new Error(JSON.stringify(result, null, 2));

    }



    async runCommand(command: string, client: SshExtended, opts?: { onStdout?, onStderr?}): Promise<ShellCommandResultDto> {

        Logger.verbose(`EXEC(${client.config.host}) -> '${command}' on `);

        const result = await client.execCommand(command, {
            cwd: '/home',
            execOptions: { pty: true },

            onStdout: (_chunk) => {

                const chunk = trim(_chunk.toString(), ' \r\n\t');

                if (opts?.onStdout) opts.onStdout(chunk);

                this.wsGateway.broadcast(JSON.stringify({
                    type: 'ShellCommandResultDto.output',
                    data: {
                        command,
                        output: chunk,
                        host: client.config.host,
                    }
                }));

                Logger.verbose(`STDOUT(${client.config.host}) -> ${chunk}`);

            },
            onStderr: (_chunk) => {

                const chunk = trim(_chunk.toString(), ' \r\n\t');

                if (opts?.onStderr) opts.onStderr(chunk);

                this.wsGateway.broadcast(JSON.stringify({
                    type: 'ShellCommandResultDto.error',
                    data: {
                        command,
                        error: chunk,
                        host: client.config.host,
                    }
                }));
                Logger.verbose(`STDERR(${client.config.host}) -> ${chunk}`);
            }
        });

        const model = {
            host: client.config.host,
            code: result.code,
            signal: result.signal,
            errors: result.stderr?.split('\n'),
            outputs: result.stdout?.split('\n')
        };

        return model;

    }


}
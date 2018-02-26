'use strict';

const lib = require('../lib');
const CONST = require('../lib/constants');
const CloudProviderClient = lib.iaas.CloudProviderClient;
const backupStoreBase = lib.iaas.backupStoreBase;

describe('iaas', function () {
    describe('backupStore', function () {
        describe('listBackupFilenames', function () {
            let sandbox, listStub;
            const deployment_name = 'ccdb-postgresql';
            const oob_backup_guid = 'oob-backup-guid';
            const service_instance_backup_guid = 'service-instance-backup-guid';
            const tenant_id = 'space-guid';
            const service_guid = 'service-guid';
            const instance_guid = 'instance-guid';
            const oob_backup_started_at_suffix = new Date((new Date()).getTime() - 1000 * 600).toISOString().replace(/\.\d*/, '').replace(/:/g, '-');
            const service_instance_backup_started_at_suffix = new Date((new Date()).getTime() - 1000 * 1200).toISOString().replace(/\.\d*/, '').replace(/:/g, '-');
            const operation = 'backup';
            before(function () {
                sandbox = sinon.sandbox.create();
                listStub = sandbox.stub(CloudProviderClient.prototype, 'list');
                listStub.returns(Promise.resolve([{
                    name: `${CONST.FABRIK_OUT_OF_BAND_DEPLOYMENTS.ROOT_FOLDER_NAME}/${operation}/${deployment_name}.${oob_backup_guid}.${oob_backup_started_at_suffix}.json`
                }, {
                    name: `${tenant_id}/${operation}/${service_guid}.${instance_guid}.${service_instance_backup_guid}.${service_instance_backup_started_at_suffix}.json`
                }]));
            });
            afterEach(function () {
                listStub.reset();
            });
            after(function () {
                sandbox.restore();
            });

            it('should list all backup file names', function () {
                return backupStoreBase.listBackupFilenames(Date.now(), undefined, true).then(filenameObject => {
                    expect(filenameObject).to.have.lengthOf(2);
                    expect(filenameObject[0].root_folder).to.equal(tenant_id);
                    expect(filenameObject[1].root_folder).to.equal(CONST.FABRIK_OUT_OF_BAND_DEPLOYMENTS.ROOT_FOLDER_NAME);
                    expect(filenameObject[0].backup_guid).to.equal(service_instance_backup_guid);
                    expect(filenameObject[1].backup_guid).to.equal(oob_backup_guid);
                });
            });
        });
    });
});
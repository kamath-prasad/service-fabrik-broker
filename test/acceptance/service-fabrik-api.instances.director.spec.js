'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const moment = require('moment');
const lib = require('../../lib');
const ScheduleManager = require('../../lib/jobs');
const CONST = require('../../lib/constants');
const apps = require('../../apps');
const catalog = lib.models.catalog;
const config = lib.config;
const errors = lib.errors;
const fabrik = lib.fabrik;
const utils = lib.utils;
const NotFound = errors.NotFound;
const backupStore = lib.iaas.backupStore;
const filename = lib.iaas.backupStore.filename;
const logger = require('../../lib/logger');


describe('service-fabrik-api', function () {

  describe('instances', function () {
    /* jshint expr:true */
    describe('director', function () {
      const base_url = '/api/v1';
      const broker_api_base_url = '/cf/v2';
      const broker_api_version = '2.9';
      const authHeader = `bearer ${mocks.uaa.jwtToken}`;
      const adminAuthHeader = `bearer ${mocks.uaa.adminJwtToken}`;
      const authHeaderInsufficientScopes = `bearer ${mocks.uaa.jwtTokenInsufficientScopes}`;
      const index = mocks.director.networkSegmentIndex;
      const service_id = '24731fb8-7b84-4f57-914f-c3d55d793dd4';
      const plan_id = 'bc158c9a-7934-401e-94ab-057082a5073f';
      const plan_guid = '60750c9c-8937-4caf-9e94-c38cbbbfd191';
      const plan = catalog.getPlan(plan_id);
      const instance_id = mocks.director.uuidByIndex(index);
      const space_guid = 'e7c0a437-7585-4d75-addf-aa4d45b49f3a';
      const organization_guid = 'c84c8e58-eedc-4706-91fb-e8d97b333481';
      const backup_guid = '071acb05-66a3-471b-af3c-8bbf1e4180be';
      const time = Date.now();
      const started_at = isoDate(time);
      const deployment_name = mocks.director.deploymentNameByIndex(index);
      const username = 'hugo';
      const container = backupStore.containerName;
      const blueprintContainer = `${backupStore.containerPrefix}-blueprint`;
      const repeatInterval = '*/1 * * * *';
      const repeatTimezone = 'America/New_York';
      const backupOperation = {
        type: 'update',
        subtype: 'backup',
        deployment: deployment_name,
        space_guid: space_guid,
        backup_guid: backup_guid,
        agent_ip: mocks.agent.ip
      };
      const restoreOperation = {
        type: 'update',
        subtype: 'restore',
        deployment: deployment_name,
        space_guid: space_guid,
        agent_ip: mocks.agent.ip
      };

      const getJob = (name, type) => {
        return Promise.resolve({
          name: `${instance_id}_${type === undefined? CONST.JOB.SCHEDULED_BACKUP : type}`,
          repeatInterval: repeatInterval,
          data: {
            instance_id: instance_id,
            type: 'online'
          },
          nextRunAt: time,
          lastRunAt: time,
          lockedAt: null,
          repeatTimezone: repeatTimezone,
          createdAt: time,
          updatedAt: time,
          createdBy: username,
          updatedBy: username
        });
      };
      let scheduleStub, getScheduleStub, cancelScheduleStub, timestampStub;

      function isoDate(time) {
        return new Date(time).toISOString().replace(/\.\d*/, '').replace(/:/g, '-');
      }

      before(function () {
        config.mongodb.provision.plan_id = 'bc158c9a-7934-401e-94ab-057082a5073f';
        backupStore.cloudProvider = new lib.iaas.CloudProviderClient(config.backup.provider);
        mocks.cloudProvider.auth();
        mocks.cloudProvider.getContainer(container);
        _.unset(fabrik.DirectorManager, plan_id);
        timestampStub = sinon.stub(filename, 'timestamp');
        timestampStub.withArgs().returns(started_at);
        scheduleStub = sinon.stub(ScheduleManager, 'schedule', getJob);
        getScheduleStub = sinon.stub(ScheduleManager, 'getSchedule', getJob);
        cancelScheduleStub = sinon.stub(ScheduleManager, 'cancelSchedule', () => Promise.resolve({}));
        return mocks.setup([
          fabrik.DirectorManager.load(plan),
          backupStore.cloudProvider.getContainer()
        ]);
      });

      afterEach(function () {
        timestampStub.reset();
        cancelScheduleStub.reset();
        scheduleStub.reset();
        getScheduleStub.reset();
        mocks.reset();
      });

      after(function () {
        timestampStub.restore();
        backupStore.cloudProvider = lib.iaas.cloudProvider;
        cancelScheduleStub.restore();
        scheduleStub.restore();
        getScheduleStub.restore();
        delete config.mongodb.provision.plan_id;
      });

      describe('#state', function () {
        it('should return 200 OK', function () {
          const operational = true;
          const details = {
            number_of_files: 5
          };
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          let deploymentName = 'service-fabrik-0021-b4719e7c-e8d3-4f7f-c515-769ad1c3ebfa';
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.director.getDeployment(deploymentName, true);
          mocks.director.getDeployments();
          mocks.agent.getInfo();
          mocks.agent.getState(operational, details);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({
                operational: operational,
                details: details
              });
              mocks.verify();
            });
        });

        it('should return 403 Forbidden', function () {
          mocks.uaa.tokenKey();
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}`)
            .set('Authorization', authHeaderInsufficientScopes)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(403);
              mocks.verify();
            });
        });
      });
      describe('#unlock-start', function () {
        const name = 'unlock';
        const deploymentName = mocks.director.deploymentNameByIndex(mocks.director.networkSegmentIndex);
        const args = {
          description: `Backup operation for ${deploymentName} finished with status ${CONST.OPERATION.SUCCEEDED}`
        };

        it('should receive the update request from cloud controller and unlock deployment', function () {
          mocks.director.releaseLock();
          return support.jwt
            .sign({
              guid: backup_guid,
              username: username
            }, name)
            .then(token => chai
              .request(apps.internal)
              .patch(`${broker_api_base_url}/service_instances/${instance_id}`)
              .send({
                plan_id: plan_id,
                service_id: service_id,
                previous_values: {
                  plan_id: plan_id,
                  service_id: service_id,
                  organization_id: organization_guid,
                  space_id: space_guid
                },
                parameters: {
                  'service-fabrik-operation': token
                },
                accepts_incomplete: true
              })
              .set('X-Broker-API-Version', broker_api_version)
              .auth(config.username, config.password)
              .catch(err => err.response)
              .then(res => {
                expect(res).to.have.status(200);
                const expectedDescription = `Unlocked deployment ${deploymentName}`;
                expect(res.body.description).to.be.eql(expectedDescription);
                mocks.verify();
              })
            );
        });
        it('should receive the update request from cloud controller and if deployment is already unlocked, should return back successfully', function () {
          mocks.director.releaseLock(deploymentName, 404);
          return support.jwt
            .sign({
              guid: backup_guid,
              username: username
            }, name, args)
            .then(token => chai
              .request(apps.internal)
              .patch(`${broker_api_base_url}/service_instances/${instance_id}`)
              .send({
                plan_id: plan_id,
                service_id: service_id,
                previous_values: {
                  plan_id: plan_id,
                  service_id: service_id,
                  organization_id: organization_guid,
                  space_id: space_guid
                },
                parameters: {
                  'service-fabrik-operation': token
                },
                accepts_incomplete: true
              })
              .set('X-Broker-API-Version', broker_api_version)
              .auth(config.username, config.password)
              .catch(err => err.response)
              .then(res => {
                expect(res).to.have.status(200);
                expect(res.body.description).to.be.eql(args.description);
                mocks.verify();
              })
            );
        });
      });
      describe('#backup-start', function () {
        const prefix = `${space_guid}/backup/${service_id}.${plan_id}.${instance_id}.${backup_guid}`;
        const filename = `${prefix}.${started_at}.json`;
        const pathname = `/${container}/${filename}`;
        const type = 'online';
        const name = 'backup';
        const args = {
          type: type,
          trigger: CONST.BACKUP.TRIGGER.ON_DEMAND
        };
        const scheduled_args = {
          type: type,
          trigger: CONST.BACKUP.TRIGGER.SCHEDULED
        };
        const list_prefix = `${space_guid}/backup/${service_id}.${plan_id}.${instance_id}`;
        const list_filename = `${list_prefix}.${backup_guid}.${started_at}.json`;
        const list_filename2 = `${list_prefix}.${backup_guid}.${isoDate(time+1)}.json`;
        const list_pathname = `/${container}/${list_filename}`;
        const list_pathname2 = `/${container}/${list_filename2}`;
        const data = {
          trigger: CONST.BACKUP.TRIGGER.ON_DEMAND,
          state: 'succeeded',
          agent_ip: mocks.agent.ip
        };
        const instanceInfo = {
          space_guid: space_guid,
          backup_guid: backup_guid,
          instance_guid: instance_id,
          agent_ip: '10.0.1.10',
          service_id: service_id,
          plan_id: plan_id,
          deployment: mocks.director.deploymentNameByIndex(index),
          started_at: new Date()
        };
        const lockInfo = {
          username: 'admin',
          lockedForOperation: 'backup',
          createdAt: new Date(),
          instanceInfo: instanceInfo
        };
        const FabrikStatusPoller = require('../../lib/fabrik/FabrikStatusPoller');
        afterEach(function () {
          FabrikStatusPoller.stopPoller = true;
          FabrikStatusPoller.clearAllPollers();
        });
        it('should initiate a start-backup operation at cloud controller via a service instance update', function (done) {
          mocks.uaa.tokenKey();
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudProvider.list(container, list_prefix, [
            list_filename
          ]);
          mocks.cloudProvider.download(list_pathname, data);
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.updateServiceInstance(instance_id, body => {
            const token = _.get(body.parameters, 'service-fabrik-operation');
            return support.jwt.verify(token, name, args);
          }, 201);
          //mocks.director.getLockProperty(mocks.director.deploymentNameByIndex(index), true, lockInfo);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .send({
              type: type
            })
            .catch(err => err.response)
            .then(res => {
                expect(res).to.have.status(202);
                expect(res.body).to.have.property('guid');
                mocks.verify();
                done();
            });
        });

        it('should recieve 403 forbidden on reaching quota of on-demand backups', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudProvider.list(container, list_prefix, [
            list_filename,
            list_filename2
          ]);
          mocks.cloudProvider.download(list_pathname, data);
          mocks.cloudProvider.download(list_pathname2, data);
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .set('Accept', 'application/json')
            .send({
              type: type
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(403);
              expect(res.body.message).to.eql(`Reached max quota of ${config.backup.max_num_on_demand_backup} ${CONST.BACKUP.TRIGGER.ON_DEMAND} backups`);
              mocks.verify();
            });
        });

        it('should recieve 403 forbidden for trying to trigger scheduled backup', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .set('Accept', 'application/json')
            .send({
              type: type,
              trigger: CONST.BACKUP.TRIGGER.SCHEDULED
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(403);
              expect(res.body.message).to.eql('Scheduled backups can only be initiated by the System User');
              mocks.verify();
            });
        });

        it('should initiate a scheduled backup operation at cloud controller when initiated by cf admin user', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          //mocks.director.getLockProperty(mocks.director.deploymentNameByIndex(index), true, lockInfo);
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          //cloud controller admin check will ensure getSpaceDeveloper isnt called, so no need to set that mock.
          mocks.cloudController.updateServiceInstance(instance_id, body => {
            const token = _.get(body.parameters, 'service-fabrik-operation');
            return support.jwt.verify(token, name, scheduled_args);
          }, 201);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', adminAuthHeader)
            .set('Accept', 'application/json')
            .send({
              type: type,
              trigger: CONST.BACKUP.TRIGGER.SCHEDULED
            })
            .catch(err => err.response)
            .then(res => Promise.delay(20).then(() => {
              expect(res).to.have.status(202);
              expect(res.body).to.have.property('guid');
              mocks.verify();
            }));
        });

        it('should initiate a  backup operation at cloud controller & if a backup is already in progress then it must result in DeploymentAlready locked message', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.director.getLockProperty(mocks.director.deploymentNameByIndex(index), true, lockInfo);
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          //cloud controller admin check will ensure getSpaceDeveloper isnt called, so no need to set that mock.
          const SERVER_ERROR_CODE = 502;
          const LOCK_MESSAGE = 'Deployment service-fabrik-0315-b9bf180e-1a67-48b6-9cad-32bd2e936849 __Locked__ by admin at Wed Oct 11 2017 04:09:38 GMT+0000 (UTC) for on-demand_backup';
          const error_response_body = {
            description: `The service broker rejected the request to ${base_url}/service_instances/b9bf180e-1a67-48b6-9cad-32bd2e936849?accepts_incomplete=true. 
            Status Code: 422 Unprocessable Entity, Body: {"status":422,"message":"${LOCK_MESSAGE}"}`,
            error_code: 'CF-ServiceBrokerRequestRejected',
            code: 10001,
            http: {
              uri: `${base_url}/service_instances/b9bf180e-1a67-48b6-9cad-32bd2e936849?accepts_incomplete=true`,
              method: 'PATCH',
              status: 422
            }
          };
          mocks.cloudController.updateServiceInstance(instance_id, body => {
            const token = _.get(body.parameters, 'service-fabrik-operation');
            return support.jwt.verify(token, name, scheduled_args);
          }, SERVER_ERROR_CODE, error_response_body);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', adminAuthHeader)
            .set('Accept', 'application/json')
            .send({
              type: type,
              trigger: CONST.BACKUP.TRIGGER.SCHEDULED
            })
            .then(() => {
              throw new Error('Should throw error');
            })
            .catch(err => {
              expect(_.get(err, 'response.body.status')).to.equal(error_response_body.http.status);
              expect(_.get(err, 'response.body.message')).to.equal(LOCK_MESSAGE);
            });
        });

        it('should receive the update request from cloud controller and start the backup', function () {
          mocks.director.getDeploymentManifest();
          mocks.director.acquireLock();
          mocks.director.verifyDeploymentLockStatus();
          mocks.director.getDeploymentVms(deployment_name);
          mocks.agent.getInfo();
          mocks.agent.startBackup();
          mocks.cloudProvider.upload(pathname, body => {
            expect(body.type).to.equal(type);
            expect(body.instance_guid).to.equal(instance_id);
            expect(body.username).to.equal(username);
            expect(body.backup_guid).to.equal(backup_guid);
            expect(body.trigger).to.equal(CONST.BACKUP.TRIGGER.ON_DEMAND);
            expect(body.state).to.equal('processing');
            return true;
          });
          mocks.cloudProvider.headObject(pathname);
          return support.jwt
            .sign({
              guid: backup_guid,
              username: username
            }, name, args)
            .then(token => chai
              .request(apps.internal)
              .patch(`${broker_api_base_url}/service_instances/${instance_id}`)
              .send({
                plan_id: plan_id,
                service_id: service_id,
                previous_values: {
                  plan_id: plan_id,
                  service_id: service_id,
                  organization_id: organization_guid,
                  space_id: space_guid
                },
                parameters: {
                  'service-fabrik-operation': token
                },
                accepts_incomplete: true
              })
              .set('X-Broker-API-Version', broker_api_version)
              .auth(config.username, config.password)
              .catch(err => err.response)
              .then(res => {
                expect(res).to.have.status(200);
                expect(res.body.description).to.be.defined;
                mocks.verify();
              })
            );
        });

        it('should receive last_operation call from cloud controller while backup is processing', function () {
          const backupState = {
            state: 'processing',
            stage: 'Creating volume',
            updated_at: new Date(Date.now())
          };
          mocks.agent.lastBackupOperation(backupState);
          return chai
            .request(apps.internal)
            .get(`${broker_api_base_url}/service_instances/${instance_id}/last_operation`)
            .set('X-Broker-API-Version', broker_api_version)
            .auth(config.username, config.password)
            .query({
              service_id: service_id,
              plan_id: plan_id,
              operation: utils.encodeBase64(backupOperation)
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body.state).to.equal('in progress');
              expect(res.body).to.have.property('description');
              mocks.verify();
            });
        });

        it('should download the backup logs and update the metadata', function () {
          const state = 'succeeded';
          const backupState = {
            state: state,
            stage: 'Finished',
            updated_at: new Date(Date.now()),
            snapshotId: 'snap-12345678'
          };
          const backupLogs = [{
            time: '2015-11-18T11:28:40+00:00',
            level: 'info',
            msg: 'Creating snapshot ...'
          }, {
            time: '2015-11-18T11:28:42+00:00',
            level: 'info',
            msg: 'Creating volume ...'
          }];
          const backupLogsStream = _
            .chain(backupLogs)
            .map(JSON.stringify)
            .join('\n')
            .value();

          mocks.cloudProvider.list(container, prefix, [filename]);
          mocks.cloudProvider.download(pathname, {});
          mocks.agent.lastBackupOperation(backupState);
          mocks.agent.getBackupLogs(backupLogsStream);
          mocks.cloudProvider.upload(pathname, body => {
            expect(body.logs).to.eql(backupLogs);
            expect(body.state).to.equal(state);
            expect(body.snapshotId).to.equal(backupState.snapshotId);
            expect(body.finished_at).to.not.be.undefined;
            return true;
          });
          mocks.cloudProvider.headObject(pathname);
          return chai
            .request(apps.internal)
            .get(`${broker_api_base_url}/service_instances/${instance_id}/last_operation`)
            .set('X-Broker-API-Version', broker_api_version)
            .auth(config.username, config.password)
            .query({
              service_id: service_id,
              plan_id: plan_id,
              operation: utils.encodeBase64(backupOperation)
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body.state).to.equal(state);
              expect(res.body).to.have.property('description');
              mocks.verify();
            });
        });
      });

      describe('#backup-state', function () {
        const prefix = `${space_guid}/backup/${service_id}.${plan_id}.${instance_id}`;
        const filename = `${prefix}.${backup_guid}.${started_at}.json`;
        const pathname = `/${container}/${filename}`;
        const data = {
          trigger: CONST.BACKUP.TRIGGER.ON_DEMAND,
          state: 'processing',
          agent_ip: mocks.agent.ip
        };
        const backupState = {
          state: 'aborting',
          stage: 'Deleting volume',
          updated_at: new Date(Date.now())
        };

        it('should return 200 Ok - backup state is retrieved from agent while in \'processing\' state', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [filename]);
          mocks.cloudProvider.download(pathname, data);
          mocks.agent.lastBackupOperation(backupState);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .query({
              no_cache: true
            })
            .catch(err => err.response)
            .then(res => {
              const result = _
                .chain(data)
                .omit('agent_ip')
                .merge(_.pick(backupState, 'state', 'stage'))
                .value();
              expect(res).to.have.status(200);
              expect(res.body).to.eql(result);
              mocks.verify();
            });
        });

        it('should return 200 Ok - backup state retrieved from meta information itself even when in-processing state', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [filename]);
          mocks.cloudProvider.download(pathname, data);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              const result = _
                .chain(data)
                .omit('agent_ip')
                .value();
              expect(res).to.have.status(200);
              expect(res.body).to.eql(result);
              mocks.verify();
            });
        });

        it('should return 404 Not Found', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, []);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(404);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });

      describe('#backup-abort', function () {
        const prefix = `${space_guid}/backup/${service_id}.${plan_id}.${instance_id}`;
        const filename = `${prefix}.${backup_guid}.${started_at}.json`;
        const pathname = `/${container}/${filename}`;
        const data = {
          trigger: CONST.BACKUP.TRIGGER.ON_DEMAND,
          state: 'processing',
          agent_ip: mocks.agent.ip
        };

        it('should return 202 Accepted', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [filename]);
          mocks.cloudProvider.download(pathname, _
            .chain(data)
            .omit('state')
            .set('state', 'processing')
            .value()
          );
          mocks.agent.abortBackup();
          return chai
            .request(apps.external)
            .delete(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(202);
              expect(res.body).to.be.empty;
              mocks.verify();
            });
        });
        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [filename]);
          mocks.cloudProvider.download(pathname, _
            .chain(data)
            .omit('state')
            .set('state', 'succeeded')
            .value()
          );
          return chai
            .request(apps.external)
            .delete(`${base_url}/service_instances/${instance_id}/backup`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.be.empty;
              mocks.verify();
            });
        });
      });

      describe('#restore-start', function () {
        const restorePrefix = `${space_guid}/restore/${service_id}.${plan_id}.${instance_id}`;
        const backupPrefix = `${space_guid}/backup`;
        const restoreFilename = `${restorePrefix}.json`;
        const backupFilename = `${backupPrefix}/${service_id}.${plan_id}.${instance_id}.${backup_guid}.${started_at}.json`;
        const restorePathname = `/${container}/${restoreFilename}`;
        const backupPathname = `/${container}/${backupFilename}`;
        const name = 'restore';
        const backupMetadata = {
          plan_id: plan_id,
          state: 'succeeded',
          type: 'online',
          secret: 'hugo'
        };
        const args = {
          backup_guid: backup_guid,
          backup: _.pick(backupMetadata, 'type', 'secret')
        };

        it('should return 400 Bad Request (no or invalid backup_guid given)', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/restore`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(400);
              mocks.verify();
            });
        });

        it('should return 422 Unprocessable Entity (no backup with this guid found)', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, backupPrefix, []);
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/restore`)
            .send({
              backup_guid: backup_guid
            })
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(422);
              mocks.verify();
            });
        });

        it('should return 422 Unprocessable Entity (backup still in progress)', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, backupPrefix, [backupFilename]);
          mocks.cloudProvider.download(backupPathname, {
            state: 'processing'
          });
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/restore`)
            .send({
              backup_guid: backup_guid
            })
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(422);
              mocks.verify();
            });
        });

        it('should return 422 Unprocessable Entity (plan ids do not match)', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, backupPrefix, [backupFilename]);
          mocks.cloudProvider.download(backupPathname, {
            plan_id: 'some-other-plan-id'
          });
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/restore`)
            .send({
              backup_guid: backup_guid
            })
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(422);
              mocks.verify();
            });
        });

        it('should initiate a start-restore operation at cloud controller via a service instance update', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, backupPrefix, [backupFilename]);
          mocks.cloudProvider.download(backupPathname, backupMetadata);
          mocks.cloudController.updateServiceInstance(instance_id, body => {
            const token = _.get(body.parameters, 'service-fabrik-operation');
            return support.jwt.verify(token, name, args);
          });
          return chai
            .request(apps.external)
            .post(`${base_url}/service_instances/${instance_id}/restore`)
            .set('Authorization', authHeader)
            .send({
              backup_guid: backup_guid
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(202);
              expect(res.body).to.have.property('guid');
              mocks.verify();
            });
        });

        it('should receive the update request from cloud controller and start the restore', function () {
          mocks.director.getDeploymentManifest();
          mocks.director.getDeploymentVms(deployment_name);
          mocks.director.verifyDeploymentLockStatus();
          mocks.agent.getInfo();
          mocks.agent.startRestore();
          mocks.cloudProvider.upload(restorePathname, body => {
            expect(body.instance_guid).to.equal(instance_id);
            expect(body.username).to.equal(username);
            expect(body.backup_guid).to.equal(backup_guid);
            expect(body.state).to.equal('processing');
            return true;
          });
          mocks.cloudProvider.headObject(restorePathname);
          return support.jwt
            .sign({
              username: username
            }, name, args)
            .then(token => chai
              .request(apps.internal)
              .patch(`${broker_api_base_url}/service_instances/${instance_id}`)
              .send({
                plan_id: plan_id,
                service_id: service_id,
                previous_values: {
                  plan_id: plan_id,
                  service_id: service_id,
                  organization_id: organization_guid,
                  space_id: space_guid
                },
                parameters: {
                  'service-fabrik-operation': token
                },
                accepts_incomplete: true
              })
              .set('X-Broker-API-Version', broker_api_version)
              .auth(config.username, config.password)
              .catch(err => err.response)
              .then(res => {
                expect(res).to.have.status(202);
                expect(res.body).to.have.property('operation');
                const operation = utils.decodeBase64(res.body.operation);
                expect(operation.type).to.equal('update');
                expect(operation.subtype).to.equal('restore');
                expect(operation).to.have.property('agent_ip');
                mocks.verify();
              })
            );
        });

        it('should receive last_operation call from cloud controller while restore is processing', function () {
          const restoreState = {
            state: 'processing',
            stage: 'Attaching volume',
            updated_at: new Date(Date.now())
          };
          mocks.agent.lastRestoreOperation(restoreState);
          return chai
            .request(apps.internal)
            .get(`${broker_api_base_url}/service_instances/${instance_id}/last_operation`)
            .set('X-Broker-API-Version', broker_api_version)
            .auth(config.username, config.password)
            .query({
              service_id: service_id,
              plan_id: plan_id,
              operation: utils.encodeBase64(restoreOperation)
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body.state).to.equal('in progress');
              expect(res.body).to.have.property('description');
              mocks.verify();
            });
        });

        it('should download the restore logs and update the metadata', function () {
          const state = 'succeeded';
          const restoreState = {
            state: state,
            stage: 'Finished',
            updated_at: new Date(Date.now())
          };
          const restoreLogs = [{
            time: '2015-11-18T11:28:40+00:00',
            level: 'info',
            msg: 'Downloading tarball ...'
          }, {
            time: '2015-11-18T11:28:42+00:00',
            level: 'info',
            msg: 'Extracting tarball ...'
          }];
          const restoreLogsStream = _
            .chain(restoreLogs)
            .map(JSON.stringify)
            .join('\n')
            .value();

          mocks.cloudProvider.download(restorePathname, {});
          mocks.agent.lastRestoreOperation(restoreState);
          mocks.agent.getRestoreLogs(restoreLogsStream);
          mocks.cloudProvider.upload(restorePathname, body => {
            expect(body.logs).to.eql(restoreLogs);
            expect(body.state).to.equal(state);
            expect(body.finished_at).to.not.be.undefined;
            return true;
          });
          mocks.cloudProvider.headObject(restorePathname);
          return chai
            .request(apps.internal)
            .get(`${broker_api_base_url}/service_instances/${instance_id}/last_operation`)
            .set('X-Broker-API-Version', broker_api_version)
            .auth(config.username, config.password)
            .query({
              service_id: service_id,
              plan_id: plan_id,
              operation: utils.encodeBase64(restoreOperation)
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body.state).to.equal(state);
              expect(res.body).to.have.property('description');
              mocks.verify();
            });
        });
      });

      describe('#restore-state', function () {
        const prefix = `${space_guid}/restore/${service_id}.${plan_id}.${instance_id}`;
        const filename = `${prefix}.json`;
        const pathname = `/${container}/${filename}`;
        const data = {
          state: 'processing',
          agent_ip: mocks.agent.ip
        };
        const restoreState = {
          state: 'processing',
          stage: 'Downloading tarball',
          updated_at: new Date(Date.now())
        };

        it('should return 200 Ok', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.download(pathname, data);
          mocks.agent.lastRestoreOperation(restoreState);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/restore`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql(_.merge(data, _.pick(restoreState, 'state', 'stage')));
              mocks.verify();
            });
        });

        it('should return 404 Not Found', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.download(pathname, new NotFound('not found'));
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/restore`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(404);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });

      describe('#restore-abort', function () {
        const prefix = `${space_guid}/restore/${service_id}.${plan_id}.${instance_id}`;
        const filename = `${prefix}.json`;
        const pathname = `/${container}/${filename}`;
        const data = {
          state: 'processing',
          agent_ip: mocks.agent.ip
        };

        it('should return 202 Accepted', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.download(pathname, _
            .chain(data)
            .omit('state')
            .set('state', 'processing')
            .value()
          );
          mocks.agent.abortRestore();
          return chai
            .request(apps.external)
            .delete(`${base_url}/service_instances/${instance_id}/restore`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(202);
              expect(res.body).to.be.empty;
              mocks.verify();
            });
        });
        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.download(pathname, _
            .chain(data)
            .omit('state')
            .set('state', 'succeeded')
            .value()
          );
          return chai
            .request(apps.external)
            .delete(`${base_url}/service_instances/${instance_id}/restore`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.be.empty;
              mocks.verify();
            });
        });
      });

      describe('#listLastBackups', function () {
        const prefix = `${space_guid}/backup/${service_id}`;
        const filename1 = `${prefix}.${plan_id}.${instance_id}.${backup_guid}.${started_at}.json`;
        const filename2 = `${prefix}.${plan_id}.${instance_id}.${backup_guid}.${isoDate(time+1)}.json`;
        const filename3 = `${prefix}.${plan_id}.${instance_id}.${backup_guid}.${isoDate(time+2)}.json`;
        const pathname3 = `/${container}/${filename3}`;
        const data = {
          trigger: CONST.BACKUP.TRIGGER.ON_DEMAND,
          state: 'processing',
          agent_ip: mocks.agent.ip,
          logs: []
        };

        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [
            filename1,
            filename2,
            filename3
          ]);
          mocks.cloudProvider.download(pathname3, data);
          return chai
            .request(apps.external)
            .get(`${base_url}/service_instances/backup`)
            .query({
              space_guid: space_guid,
              service_id: service_id
            })
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              const body = [_.omit(data, 'agent_ip', 'logs')];
              expect(res.body).to.eql(body);
              mocks.verify();
            });
        });
      });

      describe('#listLastRestores', function () {
        const instance_id2 = 'fff659f7-3fb4-4034-aaf3-ab103698f6b0';
        const prefix = `${space_guid}/restore/${service_id}`;
        const filename1 = `${prefix}.${plan_id}.${instance_id}.json`;
        const filename2 = `${prefix}.${plan_id}.${instance_id2}.json`;
        const pathname1 = `/${container}/${filename1}`;
        const pathname2 = `/${container}/${filename2}`;
        const data = {
          state: 'processing',
          agent_ip: mocks.agent.ip,
          logs: []
        };

        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [
            filename1,
            filename2
          ]);
          mocks.cloudProvider.download(pathname1, data);
          mocks.cloudProvider.download(pathname2, data);
          return chai
            .request(apps.external)
            .get(`${base_url}/service_instances/restore`)
            .query({
              space_guid: space_guid,
              service_id: service_id
            })
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              const body = _.omit(data, 'agent_ip', 'logs');
              expect(res.body).to.eql([
                body,
                body
              ]);
              mocks.verify();
            });
        });
      });

      describe('#backup-delete', function () {
        const prefix = `${space_guid}/backup`;
        const started14DaysPrior = filename.isoDate(moment()
          .subtract(config.backup.retention_period_in_days + 1, 'days').toISOString());
        const filenameObj = `${prefix}/${service_id}.${plan_id}.${instance_id}.${backup_guid}.${started_at}.json`;
        const filename14DaysPrior = `${prefix}/${service_id}.${plan_id}.${instance_id}.${backup_guid}.${started14DaysPrior}.json`;
        const pathname = `/${container}/${filenameObj}`;
        const pathName14DaysPrior = `/${container}/${filename14DaysPrior}`;
        const data = {
          trigger: CONST.BACKUP.TRIGGER.ON_DEMAND,
          state: 'succeeded',
          backup_guid: backup_guid,
          agent_ip: mocks.agent.ip,
          service_id: service_id
        };

        const scheduled_data = {
          trigger: CONST.BACKUP.TRIGGER.SCHEDULED,
          state: 'succeeded',
          backup_guid: backup_guid,
          started_at: new Date().toISOString(),
          agent_ip: mocks.agent.ip,
          service_id: service_id
        };

        it('should return 200 for an on-demand backup', function () {
          mocks.uaa.tokenKey();
          //cloud controller admin check will ensure getSpaceDeveloper isnt called, so no need to set that mock.
          mocks.cloudProvider.list(container, prefix, [
            filenameObj
          ]);
          mocks.cloudProvider.download(pathname, data);
          mocks.cloudProvider.list(blueprintContainer, backup_guid, [
            backup_guid
          ]);
          mocks.cloudProvider.remove(`/${blueprintContainer}/${backup_guid}`);
          mocks.cloudProvider.remove(pathname);
          return chai.request(apps.external)
            .delete(`${base_url}/backups/${backup_guid}?space_guid=${space_guid}`)
            .set('Authorization', adminAuthHeader)
            .set('Accept', 'application/json')
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });

        it(`should return 403 for a scheduled backup within ${config.backup.retention_period_in_days} days`, function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.cloudProvider.list(container, prefix, [
            filenameObj
          ]);
          mocks.cloudProvider.download(pathname, scheduled_data);
          return chai.request(apps.external)
            .delete(`${base_url}/backups/${backup_guid}?space_guid=${space_guid}`)
            .set('Authorization', authHeader)
            .set('Accept', 'application/json')
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(403);
              expect(res.body.message).to.eql(`Delete of scheduled backup not permitted within retention period of ${config.backup.retention_period_in_days} days`);
              mocks.verify();
            });
        });

        it(`should return 200 for a scheduled backup After ${config.backup.retention_period_in_days} days`, function () {
          mocks.uaa.tokenKey();
          //cloud controller admin check will ensure getSpaceDeveloper isnt called, so no need to set that mock.
          mocks.cloudProvider.list(container, prefix, [
            filename14DaysPrior
          ]);
          scheduled_data.started_at = started14DaysPrior;
          mocks.cloudProvider.download(pathName14DaysPrior, scheduled_data);
          mocks.cloudProvider.list(blueprintContainer, backup_guid, [
            backup_guid
          ]);
          mocks.cloudProvider.remove(`/${blueprintContainer}/${backup_guid}`);
          mocks.cloudProvider.remove(pathName14DaysPrior);
          return chai.request(apps.external)
            .delete(`${base_url}/backups/${backup_guid}?space_guid=${space_guid}`)
            .set('Authorization', adminAuthHeader)
            .set('Accept', 'application/json')
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });

      describe('#backup-schedule', function () {
        it('should return 503 - schedule backup feature not enabled', function () {
          const mongourl = config.mongodb.url;
          const mongoprovision = config.mongodb.provision;
          delete config.mongodb.url;
          delete config.mongodb.provision;
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .put(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', authHeader)
            .set('Accept', 'application/json')
            .send({
              type: 'online',
              repeatInterval: '*/1 * * * *'
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(503);
              expect(res.body.message).to.eql(`${CONST.FEATURE.SCHEDULED_BACKUP} feature not enabled`);
              config.mongodb.url = mongourl;
              config.mongodb.provision = mongoprovision;
              mocks.verify();
            });
        });

        it('should return 400 - Bad request on skipping mandatory params', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .put(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', authHeader)
            .send({})
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(400);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });

        it('should return 201 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .put(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', authHeader)
            .send({
              type: 'online',
              repeatInterval: '*/1 * * * *'
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(201);
              expect(res.body).to.eql(getJob().value());
              mocks.verify();
            });
        });
      });

      describe('#GetBackupSchedule', function () {
        it('should return 503 - schedule backup feature not enabled', function () {
          const mongourl = config.mongodb.url;
          delete config.mongodb.url;
          const mongodbprovision = config.mongodb.provision;
          mocks.uaa.tokenKey();
          delete config.mongodb.provision;
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', authHeader)
            .set('accept', 'application/json')
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(503);
              expect(res.body.message).to.eql(`${CONST.FEATURE.SCHEDULED_BACKUP} feature not enabled`);
              config.mongodb.url = mongourl;
              config.mongodb.provision = mongodbprovision;
              mocks.verify();
            });
        });
        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql(getJob().value());
              mocks.verify();
            });
        });
      });

      describe('#CancelBackupSchedule', function () {
        it('should return 503 - schedule backup feature not enabled', function () {
          const mongourl = config.mongodb.url;
          const mongoprovision = config.mongodb.provision;
          delete config.mongodb.url;
          delete config.mongodb.provision;
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .delete(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', authHeader)
            .set('accept', 'application/json')
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(503);
              expect(res.body.message).to.eql(`${CONST.FEATURE.SCHEDULED_BACKUP} feature not enabled`);
              config.mongodb.url = mongourl;
              config.mongodb.provision = mongoprovision;
              mocks.verify();
            });
        });
        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          return chai.request(apps.external)
            .delete(`${base_url}/service_instances/${instance_id}/schedule_backup`)
            .set('Authorization', adminAuthHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });

      describe('#schedule-update', function () {
        it('should return 503 - schedule update feature not enabled', function () {
          const mongourl = config.mongodb.url;
          const mongoprovision = config.mongodb.provision;
          delete config.mongodb.url;
          delete config.mongodb.provision;
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .put(`${base_url}/service_instances/${instance_id}/schedule_update`)
            .set('Authorization', authHeader)
            .set('Accept', 'application/json')
            .send({
              type: 'online',
              repeatInterval: '*/1 * * * *'
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(503);
              expect(res.body.message).to.eql(`${CONST.FEATURE.SCHEDULED_UPDATE} feature not enabled`);
              config.mongodb.url = mongourl;
              config.mongodb.provision = mongoprovision;
              mocks.verify();
            });
        });

        it('should return 400 - Badrequest on skipping mandatory params', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .put(`${base_url}/service_instances/${instance_id}/schedule_update`)
            .set('Authorization', authHeader)
            .send({})
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(400);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });

        it('should return 201 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          mocks.director.getDeployments();
          return chai.request(apps.external)
            .put(`${base_url}/service_instances/${instance_id}/schedule_update`)
            .set('Authorization', authHeader)
            .send({
              type: 'online',
              repeatInterval: '*/1 * * * *'
            })
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(201);
              expect(res.body).to.eql(getJob(instance_id, CONST.JOB.SERVICE_INSTANCE_UPDATE).value());
              mocks.verify();
            });
        });
      });
      describe('#GetUpdateSchedule', function () {
        it('should return 200 OK', function () {
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/schedule_update`)
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql(getJob(instance_id, CONST.JOB.SERVICE_INSTANCE_UPDATE).value());
              mocks.verify();
            });
        });
        it('should return update required status if query param check_update_required is provided', function () {
          let deploymentName = 'service-fabrik-0021-b4719e7c-e8d3-4f7f-c515-769ad1c3ebfa';
          mocks.uaa.tokenKey();
          mocks.cloudController.getServiceInstance(instance_id, {
            space_guid: space_guid,
            service_plan_guid: plan_guid
          });
          mocks.director.getDeployments();
          mocks.director.getDeployment(deploymentName, true);
          const diff = [
            ['- name: blueprint', null],
            ['  version: 0.0.10', 'removed'],
            ['  version: 0.0.11', 'added']
          ];
          mocks.director.diffDeploymentManifest(1, diff);
          mocks.cloudController.findServicePlan(instance_id, plan_id);
          mocks.cloudController.getSpaceDevelopers(space_guid);
          return chai.request(apps.external)
            .get(`${base_url}/service_instances/${instance_id}/schedule_update`)
            .query({
              check_update_required: true
            })
            .set('Authorization', authHeader)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              const expectedJobResponse = getJob(instance_id, CONST.JOB.SERVICE_INSTANCE_UPDATE).value();
              _.set(expectedJobResponse, 'update_required', true);
              _.set(expectedJobResponse, 'update_details', diff);
              expect(res.body).to.eql(expectedJobResponse);
              mocks.verify();
            });
        });
      });
    });
  });
});
'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const logger = require('../logger');
const config = require('../config');
const CONST = require('../constants');
const moment = require('moment');
const BaseJob = require('./BaseJob');
const errors = require('../errors');
const ServiceInstanceNotFound = errors.ServiceInstanceNotFound;
const cloudController = require('../cf').cloudController;
const backupStore = require('../iaas').backupStoreBase;
const backupStoreForServiceInstance = require('../iaas').backupStore;
const backupStoreForOob = require('../iaas').backupStoreForOob;
const ScheduleManager = require('./ScheduleManager');
const EventLogInterceptor = require('../EventLogInterceptor');
const bosh = require('../bosh');

class BackupReaperJob extends BaseJob {

  static run(job, done) {
    job.__started_At = new Date();
    logger.info(`-> Starting BackupReaperJob - name: ${job.attrs.data[CONST.JOB_NAME_ATTRIB]}}`);
    return this
      .deleteOldBackup(job)
      .then((deleteResponse) => this.runSucceeded(deleteResponse, job, done))
      .catch(err => {
        logger.error(`Error occurred during BackupReaperJob start. More info:  `, err);
        this.runFailed(
          _.set(err, 'statusCode', `ERR_FABRIK_BACKUP_REAPER_FAILED_${_.get(err, 'statusCode', _.get(err, 'status', ''))}`), {}, job, done);
      });
  }

  static isServiceInstanceDeleted(instanceId) {
    return cloudController.findServicePlanByInstanceId(instanceId)
      .then(() => false)
      .catch(ServiceInstanceNotFound, () => {
        logger.warn(`service instance : ${instanceId} deleted`);
        return true;
      });
  }

  static isDeploymentDeleted(deploymentName) {
    const director = bosh.director;
    return director.getDeployment(deploymentName)
      .then(() => false)
      .catch(NotFound, () => {
        logger.warn(`Deployment : ${deploymentName} not found`);
        return true;
      });
  }

  static deleteOldBackup(job) {
    const backupStartedBefore = moment().subtract(config.backup.retention_period_in_days + 1, 'days').toISOString();
    let numberOfCfBackups = 0;
    let numberOfOobBackups = 0;
    const eventLogger = EventLogInterceptor.getInstance(config.external.event_type, 'external');
    return backupStore
      .listBackupFilenames(backupStartedBefore, undefined, true)
      .map(fileNameObject => {
        console.log(fileNameObject);
        if (isOobBackup(fileNameObject)) {
          ++numberOfOobBackups;
          return this.deleteOobBackups(job, fileNameObject, numberOfOobBackups, eventLogger);
        }
        else {
          ++numberOfCfBackups; 
          return this.deleteCFBackups(job, fileNameObject, numberOfCfBackups, eventLogger);
        }
      })
      .then(deletedBackupGuids => {
        logger.info(`Successfully deleted backup guids : ${deletedBackupGuids}`);
        const deleteResponse = {
          deleted_guids: deletedBackupGuids
        };
        return deleteResponse;
      });
  }

  static isOobBackup(fileNameObject) {
    return CONST.FABRIK_OUT_OF_BAND_DEPLOYMENTS.ROOT_FOLDER_NAME === fileNameObject.root_folder;
  }

  static deleteOobBackups(job, fileNameObject, numberOfOobBackups, eventLogger) {
    logger.debug('OOB Backup File info : ', fileNameObject);
    //on-demand backups must be deleted after instance deletion.
    const logInfo = `OOB Backup guid : ${fileNameObject.backup_guid} - backed up on : ${fileNameObject.started_at}`;
    const deleteOptions = {
      backup_guid: fileNameObject.backup_guid,
      root_folder: fileNameObject.root_folder,
      force: true,
      user: {
        name: config.cf.username,
      }
    };
    const scheduledBackupOrDeploymentDeleted = (data) => {
      return Promise.try(() => {
        if (data.trigger !== CONST.BACKUP.TRIGGER.SCHEDULED) {
          //it an on-demand backup
          //for optimization we are first checking whether for service insatnce_guid
          //scheduled backup job is there. if present it will take care of on-demand
          //backup deletion. if not will check with CF 
          return ScheduleManager
            .getSchedule(data.deployment_name, CONST.JOB.SCHEDULED_OOB_DEPLOYMENT_BACKUP)
            .then((jobData) => {
              logger.debug('jobData of deployment scheduled backup: ', jobData);
              return false;
            })
            .catch(errors.NotFound, () => this.isDeploymentDeleted(data.deployment_name));
        } else {
          return true;
        }
      });
    };

    logger.info(`-> Initiating delete of - ${logInfo}`);
    //Adding a delay for delete requests as we dont want to overload the undelying infra with too many deletes at the same second
    return Promise
      .delay(job.attrs.data.delete_delay * numberOfOobBackups)
      .then(() => {
        if (numberOfOobBackups % 30 === 0) {
          //Incase of many stale backups, once every 30 seconds touch the job which keeps the lock on the job
          job.touch(() => { });
        }
        return backupStoreForOob
          .deleteBackupFile(deleteOptions, scheduledBackupOrDeploymentDeleted)
          .then((response) => {
            if (response && response === CONST.ERR_CODES.PRE_CONDITION_NOT_MET) {
              logger.info(`${fileNameObject.backup_guid} - Backup not deleted as precondition not met`);
              return;
            }
            const resp = {
              statusCode: 200
            };
            const check_res_body = false;
            eventLogger.publishAndAuditLogEvent(CONST.URL.backup_by_guid, CONST.HTTP_METHOD.DELETE, deleteOptions, resp, check_res_body);
            logger.info(`Successfully deleted backup guid : ${fileNameObject.backup_guid}`);
            return fileNameObject.backup_guid;
          })
          .catch(err => logger.error(`Error occurred while deleting backup guid: ${fileNameObject.backup_guid}. More info: `, err));
      });
  }

  static deleteCFBackups(job, fileNameObject, numberOfCfBackups, eventLogger) {
    logger.debug('CF Backup File info : ', fileNameObject);
    //on-demand backups must be deleted after instance deletion.
    const logInfo = `CF Backup guid : ${fileNameObject.backup_guid} - backed up on : ${fileNameObject.started_at}`;
    const deleteOptions = {
      backup_guid: fileNameObject.backup_guid,
      tenant_id: fileNameObject.root_folder,
      force: true,
      user: {
        name: config.cf.username,
      }
    };
    const scheduledBackupOrInstanceDeleted = (data) => {
      return Promise.try(() => {
        if (data.trigger !== CONST.BACKUP.TRIGGER.SCHEDULED) {
          //it an on-demand backup
          //for optimization we are first checking whether for service insatnce_guid
          //scheduled backup job is there. if present it will take care of on-demand
          //backup deletion. if not will check with CF 
          return ScheduleManager
            .getSchedule(data.instance_guid, CONST.JOB.SCHEDULED_BACKUP)
            .then((jobData) => {
              logger.debug('jobData of service instance scheduled backup: ', jobData);
              return false;
            })
            .catch(errors.NotFound, () => this.isServiceInstanceDeleted(data.instance_guid));
        } else {
          return true;
        }
      });
    };
    logger.info(`-> Initiating delete of - ${logInfo}`);
    //Adding a delay for delete requests as we dont want to overload the undelying infra with too many deletes at the same second
    return Promise
      .delay(job.attrs.data.delete_delay * numberOfCfBackups)
      .then(() => {
        if (numberOfCfBackups % 30 === 0) {
          //Incase of many stale backups, once every 30 seconds touch the job which keeps the lock on the job
          job.touch(() => { });
        }
        return backupStoreForServiceInstance
          .deleteBackupFile(deleteOptions, scheduledBackupOrInstanceDeleted)
          .then((response) => {
            if (response && response === CONST.ERR_CODES.PRE_CONDITION_NOT_MET) {
              logger.info(`${fileNameObject.backup_guid} - Backup not deleted as precondition not met`);
              return;
            }
            const resp = {
              statusCode: 200
            };
            const check_res_body = false;
            eventLogger.publishAndAuditLogEvent(CONST.URL.backup_by_guid, CONST.HTTP_METHOD.DELETE, deleteOptions, resp, check_res_body);
            logger.info(`Successfully deleted backup guid : ${fileNameObject.backup_guid}`);
            return fileNameObject.backup_guid;
          })
          .catch(err => logger.error(`Error occurred while deleting backup guid: ${fileNameObject.backup_guid}. More info: `, err));
      });
  }
}

module.exports = BackupReaperJob;
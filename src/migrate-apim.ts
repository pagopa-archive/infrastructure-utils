import * as dotenv from 'dotenv';
import pLimit from 'p-limit';
import * as msRestNodeAuth from '@azure/ms-rest-nodeauth';
import {
  ApiManagementClient,
  ApiManagementModels,
} from '@azure/arm-apimanagement';

dotenv.config();

const CLEANUP = false;
const SRC_RESOURCE_GROUP_NAME = process.env.SRC_RESOURCE_GROUP_NAME || '';
const SRC_APIM_SERVICE_NAME = process.env.SRC_APIM_SERVICE_NAME || '';
const DEST_RESOURCE_GROUP_NAME = process.env.DEST_RESOURCE_GROUP_NAME || '';
const DEST_APIM_SERVICE_NAME = process.env.DEST_APIM_SERVICE_NAME || '';
const PRODUCT_ID = process.env.PRODUCT_ID || '';
const SUBSCRIPTION_ID = process.env.SUBSCRIPTION_ID || '';
const TENANT_DOMAIN = process.env.TENANT_DOMAIN || '';

function getIdFromResourcePath(resourcePath: string) {
  const splittedResourcePath = resourcePath.split('/');
  return splittedResourcePath[splittedResourcePath.length - 1];
}

async function getApimUsers(
  client: ApiManagementClient,
  resourceGroupName: string,
  apimServiceName: string
) {
  let users: ApiManagementModels.UserCollection = [];
  let nextUsers = await client.user.listByService(
    resourceGroupName,
    apimServiceName
  );
  users = users.concat(nextUsers);
  while (nextUsers.nextLink) {
    nextUsers = await client.user.listByServiceNext(nextUsers.nextLink);
    users = users.concat(nextUsers);
  }
  return users;
}

async function getApimGroups(
  client: ApiManagementClient,
  resourceGroupName: string,
  apimServiceName: string
) {
  let groups: ApiManagementModels.GroupCollection = [];
  let nextGroups = await client.group.listByService(
    resourceGroupName,
    apimServiceName
  );
  groups = groups.concat(nextGroups);
  while (nextGroups.nextLink) {
    nextGroups = await client.group.listByServiceNext(nextGroups.nextLink);
    groups = groups.concat(nextGroups);
  }
  return groups;
}

async function getApimGroupUsers(
  client: ApiManagementClient,
  resourceGroupName: string,
  apimServiceName: string,
  groupId: string
) {
  let users: ApiManagementModels.UserCollection = [];
  let nextUsers = await client.groupUser.list(
    resourceGroupName,
    apimServiceName,
    groupId
  );
  users = users.concat(nextUsers);
  while (nextUsers.nextLink) {
    nextUsers = await client.groupUser.listNext(nextUsers.nextLink);
    users = users.concat(nextUsers);
  }
  return users;
}

async function getApimSubscriptions(
  client: ApiManagementClient,
  resourceGroupName: string,
  apimServiceName: string
) {
  let subscriptions: ApiManagementModels.SubscriptionCollection = [];
  let nextSubscriptions = await client.subscription.list(
    resourceGroupName,
    apimServiceName
  );
  subscriptions = subscriptions.concat(nextSubscriptions);
  while (nextSubscriptions.nextLink) {
    nextSubscriptions = await client.subscription.listNext(
      nextSubscriptions.nextLink
    );
    subscriptions = subscriptions.concat(nextSubscriptions);
  }

  return subscriptions;
}

async function deleteApimUsers(
  client: ApiManagementClient,
  resourceGroupName: string,
  apimServiceName: string
) {
  const users = await getApimUsers(client, resourceGroupName, apimServiceName);
  const accountableUsers = users.filter((user) => user.name !== '1');

  console.log(`Users that needs to be deleted ${accountableUsers.length}`);

  const deleteUsersLimit = pLimit(10);
  const deleteUsersTasks = [];
  for (const user of accountableUsers) {
    if (user.id) {
      const userId = getIdFromResourcePath(user.id);
      deleteUsersTasks.push(
        deleteUsersLimit(async () => {
          console.log(
            `Deleting user ${user.firstName} ${user.lastName} (${user.email})`
          );
          return await client.user.deleteMethod(
            resourceGroupName,
            apimServiceName,
            userId,
            '*',
            {
              deleteSubscriptions: true,
            }
          );
        })
      );
    }
  }
  await Promise.all(deleteUsersTasks);
}

async function cleanup(
  client: ApiManagementClient,
  resourceGroupName: string,
  apimServiceName: string
) {
  // Delete APIM users (skip Administrator)
  await deleteApimUsers(client, resourceGroupName, apimServiceName);
}

async function migrateApimData() {
  // Get credentials
  const creds = await msRestNodeAuth.interactiveLogin({
    domain: TENANT_DOMAIN,
  });

  // Create client
  const client = new ApiManagementClient(creds, SUBSCRIPTION_ID);

  // STEP 1: Cleanup
  if (CLEANUP) {
    await cleanup(client, DEST_RESOURCE_GROUP_NAME, DEST_APIM_SERVICE_NAME);
  }

  // STEP 2: Migrate users
  console.log('Retrieving users');
  const users = await getApimUsers(
    client,
    SRC_RESOURCE_GROUP_NAME,
    SRC_APIM_SERVICE_NAME
  );
  // Skip Administrator user
  const accountableUsers = users.filter((user) => user.name !== '1');
  console.log(`Users that needs to be upserted: ${accountableUsers.length}`);

  const upsertUsersLimit = pLimit(10);
  const upsertUsersTasks = [];
  for (const user of accountableUsers) {
    if (user.id && user.email && user.firstName && user.lastName) {
      const userId = getIdFromResourcePath(user.id);
      const { state, note, identities, email, firstName, lastName } = user;

      upsertUsersTasks.push(
        upsertUsersLimit(() => {
          console.log(
            `Upserting user ${user.firstName} ${user.lastName} (${user.email})`
          );
          return client.user.createOrUpdate(
            DEST_RESOURCE_GROUP_NAME,
            DEST_APIM_SERVICE_NAME,
            userId,
            {
              state,
              note,
              identities,
              email,
              firstName,
              lastName,
            }
          );
        })
      );
    }
  }
  const newUsers = await Promise.all(upsertUsersTasks);
  const usersById: { [key: string]: ApiManagementModels.UserContract } = {};
  newUsers.forEach((user) => {
    if (user.id) {
      usersById[getIdFromResourcePath(user.id)] = user;
    }
  });

  // STEP 3: Migrate groups
  console.log('Retrieving groups');
  const groups = await getApimGroups(
    client,
    SRC_RESOURCE_GROUP_NAME,
    SRC_APIM_SERVICE_NAME
  );
  // Skip system groups
  const accountableGroups = groups.filter(
    (group) => group.groupContractType !== 'system'
  );
  console.log(`Groups that needs to be migrated ${accountableGroups.length}`);

  // Migrate the groups to the new APIM
  for (const group of accountableGroups) {
    if (group.id) {
      // Groups get created by terraform
      const groupId = getIdFromResourcePath(group.id);

      // Get group users
      console.log('Retrieving group users');
      const groupUsers = await getApimGroupUsers(
        client,
        SRC_RESOURCE_GROUP_NAME,
        SRC_APIM_SERVICE_NAME,
        groupId
      );
      console.log(
        `Group users that needs to be upserted for this group ${groupUsers.length}`
      );

      const upsertGroupUsersLimit = pLimit(10);
      const upsertGroupUsersTasks = [];
      for (const user of groupUsers) {
        if (user.id) {
          const groupUserId = user.id;
          upsertGroupUsersTasks.push(
            upsertGroupUsersLimit(() => {
              console.log(
                `Upserting user group ${groupId.toLowerCase()}:${user.email}`
              );
              return client.groupUser.create(
                DEST_RESOURCE_GROUP_NAME,
                DEST_APIM_SERVICE_NAME,
                groupId.toLowerCase(),
                getIdFromResourcePath(groupUserId)
              );
            })
          );
        }
      }
      await Promise.all(upsertGroupUsersTasks);
    }
  }

  // STEP 4: Migrate subscriptions
  console.log('Retrieving subscriptions');
  const subscriptions = await getApimSubscriptions(
    client,
    SRC_RESOURCE_GROUP_NAME,
    SRC_APIM_SERVICE_NAME
  );
  const accountableSubscriptions = subscriptions.filter(
    // Skip master system subscription
    (subscription) =>
      subscription.id !== undefined &&
      getIdFromResourcePath(subscription.id) !== 'master' &&
      subscription.scope ==
        `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${SRC_RESOURCE_GROUP_NAME}/providers/Microsoft.ApiManagement/service/${SRC_APIM_SERVICE_NAME}/products/${PRODUCT_ID.toLowerCase()}`
  );
  console.log(
    `Subscriptions that needs to be upserted ${accountableSubscriptions.length}`
  );

  const upsertSubscriptionsLimit = pLimit(5);
  const upsertSubscriptionsTasks = [];
  for (const subscription of accountableSubscriptions) {
    if (subscription.id && subscription.ownerId && subscription.displayName) {
      const subscriptionId = getIdFromResourcePath(subscription.id);
      const ownerId = getIdFromResourcePath(subscription.ownerId);
      if (ownerId !== '1') {
        const ownerResourceId =
          usersById[getIdFromResourcePath(subscription.ownerId)].id;
        if (ownerResourceId !== undefined) {
          const { displayName, primaryKey, secondaryKey, state } = subscription;
          upsertSubscriptionsTasks.push(
            upsertSubscriptionsLimit(() => {
              console.log(
                `Upserting subscription ${subscriptionId}:${ownerId}`
              );
              return client.subscription.createOrUpdate(
                DEST_RESOURCE_GROUP_NAME,
                DEST_APIM_SERVICE_NAME,
                subscriptionId,
                {
                  ownerId: ownerResourceId,
                  scope: `/products/${PRODUCT_ID}`,
                  displayName,
                  primaryKey,
                  secondaryKey,
                  state,
                }
              );
            })
          );
        }
      }
    }
  }
  await Promise.all(upsertSubscriptionsTasks);
}

migrateApimData()
  .then((_) => 0)
  .catch((e) => console.error(e));

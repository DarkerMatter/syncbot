// 1. SETUP
// =================================================================================================
// Load environment variables from the .env file
require('dotenv').config();

const { Client, GatewayIntentBits, Partials, Routes, REST, MessageFlags, PermissionsBitField } = require('discord.js');
const Database = require('better-sqlite3');

// 2. DATABASE INITIALIZATION
// =================================================================================================
// This database will be our "source of truth" to prevent sync loops.
const db = new Database('roles.sqlite');

// Create the table to store a user's roles. The combination of userId and roleName must be unique.
db.prepare(`
    CREATE TABLE IF NOT EXISTS synced_roles (
        userId TEXT NOT NULL,
        roleName TEXT NOT NULL,
        PRIMARY KEY (userId, roleName)
    )
`).run();

// Prepare database statements for reuse, which is more efficient.
const addRoleToDb = db.prepare('INSERT OR IGNORE INTO synced_roles (userId, roleName) VALUES (?, ?)');
const removeRoleFromDb = db.prepare('DELETE FROM synced_roles WHERE userId = ? AND roleName = ?');
const getRolesForUser = db.prepare('SELECT roleName FROM synced_roles WHERE userId = ?');
const clearRolesForUser = db.prepare('DELETE FROM synced_roles WHERE userId = ?');

// 3. DISCORD CLIENT INITIALIZATION
// =================================================================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,       // Required for server information
        GatewayIntentBits.GuildMembers, // Required to see when a member's roles change
    ],
    partials: [Partials.GuildMember], // Ensures we receive guild member events
});

// A flag to prevent the bot from processing events during its own sync operations.
const isSyncing = new Set();

// A cache to identify which roles are "syncable" (exist on more than one server).
const syncableRoles = new Map();

/**
 * Scans all guilds and populates the syncableRoles map.
 * A role is considered syncable if its name exists in more than one guild.
 */
function buildSyncableRolesCache() {
    console.log('[CACHE] Building syncable roles cache...');
    syncableRoles.clear(); // Clear cache on rebuild
    const roleCounts = new Map();
    const allRoles = new Map();

    // First, count occurrences of each role name across all guilds
    for (const guild of client.guilds.cache.values()) {
        for (const role of guild.roles.cache.values()) {
            if (role.name !== '@everyone') {
                const count = (roleCounts.get(role.name) || 0) + 1;
                roleCounts.set(role.name, count);
                allRoles.set(role.name, role);
            }
        }
    }

    // A role is syncable if it appears in more than one guild
    for (const [name, count] of roleCounts.entries()) {
        if (count > 1) {
            syncableRoles.set(name, allRoles.get(name));
        }
    }
    console.log(`[CACHE] Found ${syncableRoles.size} syncable roles:`, Array.from(syncableRoles.keys()));
}

// 4. CORE SYNC LOGIC
// =================================================================================================
/**
 * Syncs a specific user's roles across all shared servers based on the database.
 * @param {string} userId The ID of the user to sync.
 */
async function syncUserRoles(userId) {
    if (isSyncing.has(userId)) {
        console.log(`[SYNC] Already syncing roles for user ${userId}. Skipping.`);
        return;
    }
    isSyncing.add(userId);

    try {
        // console.log(`[SYNC] Starting role sync for user ${userId}...`);
        const userRolesFromDb = new Set(getRolesForUser.all(userId).map(row => row.roleName));
        // console.log(`[SYNC] User ${userId} should have roles:`, Array.from(userRolesFromDb));

        for (const guild of client.guilds.cache.values()) {
            let member;
            try {
                member = await guild.members.fetch(userId);
            } catch (error) {
                // User is not in this guild, so we skip it.
                continue;
            }

            const memberRoles = member.roles.cache;
            const memberRoleNames = new Set(memberRoles.map(r => r.name));

            // Add roles the user is missing
            for (const roleName of userRolesFromDb) {
                if (syncableRoles.has(roleName) && !memberRoleNames.has(roleName)) {
                    const roleToAdd = guild.roles.cache.find(r => r.name === roleName);
                    if (roleToAdd && !roleToAdd.managed) {
                        // console.log(`[SYNC] Adding role "${roleName}" to user ${userId} in server "${guild.name}".`);
                        await member.roles.add(roleToAdd).catch(err => console.error(`Failed to add role in ${guild.name}:`, err.message));
                    }
                }
            }

            // Remove roles the user has but shouldn't have
            for (const roleName of memberRoleNames) {
                if (syncableRoles.has(roleName) && !userRolesFromDb.has(roleName)) {
                    const roleToRemove = memberRoles.find(r => r.name === roleName);
                    if (roleToRemove && !roleToRemove.managed) {
                        // console.log(`[SYNC] Removing role "${roleName}" from user ${userId} in server "${guild.name}".`);
                        await member.roles.remove(roleToRemove).catch(err => console.error(`Failed to remove role in ${guild.name}:`, err.message));
                    }
                }
            }
        }
    } catch (error) {
        console.error(`[SYNC] An error occurred during sync for user ${userId}:`, error);
    } finally {
        isSyncing.delete(userId);
        // console.log(`[SYNC] Finished role sync for user ${userId}.`);
    }
}

// 5. DISCORD EVENT HANDLERS
// =================================================================================================
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`Ready to sync roles across ${client.guilds.cache.size} servers.`);
    buildSyncableRolesCache();

    const primaryGuildId = process.env.PRIMARY_GUILD_ID;
    if (!primaryGuildId || !client.guilds.cache.has(primaryGuildId)) {
        console.error(`[ERROR] PRIMARY_GUILD_ID is not set or the bot is not in that server. The /sync command will not work correctly.`);
    }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (isSyncing.has(newMember.id)) return;

    const oldRoles = new Set(oldMember.roles.cache.map(role => role.name));
    const newRoles = new Set(newMember.roles.cache.map(role => role.name));
    let hasChanged = false;

    for (const roleName of newRoles) {
        if (!oldRoles.has(roleName) && syncableRoles.has(roleName)) {
            console.log(`[EVENT] User ${newMember.displayName} was given syncable role "${roleName}".`);
            addRoleToDb.run(newMember.id, roleName);
            hasChanged = true;
        }
    }

    for (const roleName of oldRoles) {
        if (!newRoles.has(roleName) && syncableRoles.has(roleName)) {
            console.log(`[EVENT] Syncable role "${roleName}" was removed from ${newMember.displayName}.`);
            removeRoleFromDb.run(newMember.id, roleName);
            hasChanged = true;
        }
    }

    if (hasChanged) {
        await syncUserRoles(newMember.id);
    }
});

// 6. SLASH COMMANDS & HELPERS
// =================================================================================================

/**
 * The core logic for the /sync command. Fetches roles from the primary server for a
 * given user, updates the database, and triggers a cross-server sync.
 * @param {string} userId The user to sync.
 * @returns {Promise<{success: boolean, message: string}>} The result of the operation.
 */
async function executeSyncForUser(userId) {
    const primaryGuildId = process.env.PRIMARY_GUILD_ID;
    if (!primaryGuildId) {
        return { success: false, message: 'The primary server has not been configured by the bot owner.' };
    }

    try {
        const primaryGuild = await client.guilds.fetch(primaryGuildId).catch(() => null);
        if (!primaryGuild) {
            console.error(`[SYNC-CMD] Bot is not in the configured primary guild: ${primaryGuildId}`);
            return { success: false, message: 'Error: I cannot access the primary server.' };
        }

        const memberInPrimary = await primaryGuild.members.fetch(userId).catch(() => null);
        if (!memberInPrimary) {
            return { success: false, message: `User <@${userId}> is not a member of the primary server, so they cannot be synced.` };
        }

        const primaryRoleNames = new Set(
            memberInPrimary.roles.cache.filter(role => syncableRoles.has(role.name)).map(role => role.name)
        );

        console.log(`[SYNC-CMD] Syncing user ${userId} with roles from primary:`, Array.from(primaryRoleNames));

        db.transaction((id, roles) => {
            clearRolesForUser.run(id);
            for (const roleName of roles) { addRoleToDb.run(id, roleName); }
        })(userId, primaryRoleNames);

        await syncUserRoles(userId);
        return { success: true, message: `✅ Sync complete for <@${userId}>!` };
    } catch (error) {
        console.error(`[SYNC-CMD] Failed to execute sync for user ${userId}:`, error);
        return { success: false, message: `❌ An unexpected error occurred during the sync for <@${userId}>.` };
    }
}

/**
 * Handles the logic for the '/sync all' command, iterating through all members
 * of the primary guild and syncing them one by one.
 * @param {import('discord.js').TextBasedChannel} channel The channel to send the completion message to.
 */
async function handleAllUsersSync(channel) {
    const primaryGuildId = process.env.PRIMARY_GUILD_ID;
    const primaryGuild = await client.guilds.fetch(primaryGuildId).catch(() => null);
    if (!primaryGuild) {
        return channel.send('❌ Cannot start sync: I cannot access the primary server.');
    }

    const members = await primaryGuild.members.fetch();
    const totalMembers = members.size;
    let successCount = 0;
    let failCount = 0;
    console.log(`[SYNC-ALL] Starting sync for ${totalMembers} members from ${primaryGuild.name}.`);

    let i = 0;
    for (const member of members.values()) {
        i++;
        if (member.user.bot) {
            console.log(`[SYNC-ALL] [${i}/${totalMembers}] Skipping bot: ${member.user.username}`);
            continue;
        }

        const result = await executeSyncForUser(member.id);
        if (result.success) {
            successCount++;
        } else {
            failCount++;
            console.warn(`[SYNC-ALL] Failed for ${member.user.username}: ${result.message}`);
        }
        // Add a small delay to avoid hitting Discord API rate limits during a large sync.
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    await channel.send(`✅ **Sync All Complete!**\n- **Successful:** ${successCount}\n- **Failed/Skipped:** ${failCount}`);
}


// Define the slash command structure with subcommands
const commands = [
    {
        name: 'sync',
        description: 'Resets and syncs roles based on the primary server.',
        options: [
            {
                name: 'me',
                description: 'Sync your own roles from the primary server.',
                type: 1, // SUB_COMMAND
            },
            {
                name: 'user',
                description: 'Sync a specific user\'s roles (Admin only).',
                type: 1, // SUB_COMMAND
                options: [
                    {
                        name: 'target',
                        description: 'The user to sync.',
                        type: 6, // USER
                        required: true,
                    }
                ]
            },
            {
                name: 'all',
                description: 'Sync all members from the primary server (Admin only).',
                type: 1, // SUB_COMMAND
            }
        ]
    },
];

// Register the command with Discord.
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'sync') return;

    const subcommand = interaction.options.getSubcommand();

    // Permission check for admin-only subcommands
    if (subcommand === 'user' || subcommand === 'all') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: '❌ You must be an administrator to use this subcommand.',
                flags: [MessageFlags.Ephemeral]
            });
        }
    }

    switch (subcommand) {
        case 'me': {
            await interaction.reply({ content: `🔄 Starting sync for you...`, flags: [MessageFlags.Ephemeral] });
            const result = await executeSyncForUser(interaction.user.id);
            await interaction.followUp({ content: result.message, flags: [MessageFlags.Ephemeral] });
            break;
        }
        case 'user': {
            const userToSync = interaction.options.getUser('target');
            await interaction.reply({ content: `🔄 Starting sync for user ${userToSync.username}...`, flags: [MessageFlags.Ephemeral] });
            const result = await executeSyncForUser(userToSync.id);
            await interaction.followUp({ content: result.message, flags: [MessageFlags.Ephemeral] });
            break;
        }
        case 'all': {
            // This reply is public to let others know a large task is running.
            await interaction.reply({ content: '✅ **Starting sync for ALL members.** This may take a very long time. A message will be sent here upon completion.' });
            // Run the long task in the background without holding up the interaction.
            handleAllUsersSync(interaction.channel);
            break;
        }
    }
});

// 7. LOGIN
// =================================================================================================
client.login(process.env.DISCORD_TOKEN);

'use strict';

const db = require('../db');

// EXPUNGE deletes all messages in selected mailbox marked with \Delete
module.exports = (server, messageHandler) => (path, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'expunge',
            cid: session.id
        },
        '[%s] Deleting messages from "%s"',
        session.id,
        path
    );
    db.database.collection('mailboxes').findOne(
        {
            user: session.user.id,
            path
        },
        (err, mailboxData) => {
            if (err) {
                return callback(err);
            }
            if (!mailboxData) {
                return callback(null, 'NONEXISTENT');
            }

            let cursor = db.database
                .collection('messages')
                .find({
                    user: session.user.id,
                    mailbox: mailboxData._id,
                    undeleted: false,
                    // uid is part of the sharding key so we need it somehow represented in the query
                    uid: {
                        $gt: 0,
                        $lt: mailboxData.uidNext
                    }
                })
                .sort([['uid', 1]]);

            let deletedMessages = 0;
            let deletedStorage = 0;

            let updateQuota = next => {
                if (!deletedMessages) {
                    return next();
                }

                db.users.collection('users').findOneAndUpdate(
                    {
                        _id: mailboxData.user
                    },
                    {
                        $inc: {
                            storageUsed: -deletedStorage
                        }
                    },
                    next
                );
            };

            let processNext = () => {
                cursor.next((err, messageData) => {
                    if (err) {
                        return updateQuota(() => callback(err));
                    }
                    if (!messageData) {
                        return cursor.close(() => {
                            updateQuota(() => {
                                server.notifier.fire(session.user.id, path);
                                if (!update.silent && session && session.selected && session.selected.uidList) {
                                    session.writeStream.write({
                                        tag: '*',
                                        command: String(session.selected.uidList.length),
                                        attributes: [
                                            {
                                                type: 'atom',
                                                value: 'EXISTS'
                                            }
                                        ]
                                    });
                                }
                                return callback(null, true);
                            });
                        });
                    }

                    messageHandler.del(
                        {
                            messageData,
                            session,
                            // do not archive drafts
                            archive: !messageData.flags.includes('\\Draft'),
                            delayNotifications: true
                        },
                        err => {
                            if (err) {
                                server.logger.error(
                                    {
                                        tnx: 'EXPUNGE',
                                        err
                                    },
                                    'Failed to delete message id=%s. %s',
                                    messageData._id,
                                    err.message
                                );
                                return cursor.close(() => updateQuota(() => callback(err)));
                            }
                            server.logger.debug(
                                {
                                    tnx: 'EXPUNGE',
                                    err
                                },
                                'Deleted message id=%s',
                                messageData._id
                            );
                            deletedMessages++;
                            deletedStorage += Number(messageData.size) || 0;

                            if (!update.silent) {
                                session.writeStream.write(session.formatResponse('EXPUNGE', messageData.uid));
                            }

                            setImmediate(processNext);
                        }
                    );
                });
            };

            processNext();
        }
    );
};
